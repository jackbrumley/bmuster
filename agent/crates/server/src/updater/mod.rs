//! `bmuster-server update [--recover]`: the root updater
//! (SPEC-SERVER-UPDATES). The web app can only ask for an update, with an
//! empty flag file; this decides what to install: the newest stable
//! release, verified with the release key compiled in, never older than
//! what runs. It installs the whole release (launcher, Node and app) beside
//! the running one, switches `current` to it, and keeps it only when its app
//! reports ready with the expected version within the health window.
//!
//! Every step is written to the switch record first, so `--recover` (at
//! boot, before the service starts) finishes or undoes an interrupted
//! update the same way every time. The database is never replaced: a copy
//! is kept, and rollback happens only to a version the new release's signed
//! manifest declares able to run on the database it leaves behind.

pub mod files;
pub mod system;

use crate::layout::Layout;
use crate::releases::{self, current_version, point_current, release_dir};
use crate::updates::download::{self, read_limited, Source};
use crate::updates::manifest::{self, MAX_MANIFEST};
use anyhow::{bail, Context as _, Result};
use ed25519_dalek::VerifyingKey;
use files::{Phase, Step, Switch};
use std::fs::File;
use std::path::Path;
use std::time::{Duration, Instant};

/// How long a new release has to report ready.
pub const HEALTH_WINDOW: Duration = Duration::from_secs(120);
const POLL: Duration = Duration::from_millis(250);

/// The server's service, as the updater drives it.
pub trait Service {
    fn stop(&self) -> Result<()>;
    fn start(&self) -> Result<()>;
    /// Lets the release in `release` write its own service definitions.
    fn refresh(&self, release: &Path) -> Result<()>;
}

/// How a run ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// No flag and nothing to recover.
    NothingToDo,
    /// An interrupted update was finished or undone; no flag.
    Recovered,
    UpToDate,
    Healthy,
    RolledBack,
    /// Refused or failed; the status file says why.
    Failed,
}

pub struct Updater<'a> {
    pub layout: &'a Layout,
    pub keys: &'a [VerifyingKey],
    pub target: &'a str,
    pub service: &'a dyn Service,
    pub source: &'a dyn Source,
    pub health_window: Duration,
}

impl Updater<'_> {
    /// `update`: takes the flag (deleting it first, so a failure never
    /// loops), recovers anything interrupted, then updates when asked.
    pub fn update(&self) -> Result<Outcome> {
        files::check_data_dir(&self.layout.data)?;
        let requested = files::take_flag(&self.layout.update_flag())?;
        let record = self.layout.switch_record();
        if !requested && std::fs::symlink_metadata(&record).is_err() {
            return Ok(Outcome::NothingToDo);
        }
        let _lock = self.lock()?;
        let recovered = self.recover_if_needed(false)?;
        if !requested {
            return Ok(if recovered {
                Outcome::Recovered
            } else {
                Outcome::NothingToDo
            });
        }
        let installed = current_version(&self.layout.program)?
            .context("there is no current release to update")?;
        match self.install_latest(&installed) {
            Ok(outcome) => Ok(outcome),
            Err(e) => {
                let message = format!("The update failed: {e:#}. BMuster {installed} still runs.");
                files::write_status(self.layout, Phase::Failed, Some(&installed), None, &message)?;
                Ok(Outcome::Failed)
            }
        }
    }

    /// `update --recover`: at boot, before the service starts, so it never
    /// touches the service.
    pub fn recover_at_boot(&self) -> Result<Outcome> {
        files::check_data_dir(&self.layout.data)?;
        let _lock = self.lock()?;
        Ok(if self.recover_if_needed(true)? {
            Outcome::Recovered
        } else {
            Outcome::NothingToDo
        })
    }

    fn lock(&self) -> Result<File> {
        let path = self.layout.update_lock();
        let file = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .with_context(|| format!("could not open {}", path.display()))?;
        file.lock()
            .with_context(|| format!("could not lock {}", path.display()))?;
        Ok(file)
    }

    /// Everything up to the switch can fail without changing what runs.
    fn install_latest(&self, installed: &str) -> Result<Outcome> {
        let status = |phase, to: Option<&str>, message: &str| {
            files::write_status(self.layout, phase, Some(installed), to, message)
        };
        status(Phase::Checking, None, "Looking for a newer signed release")?;
        let latest = self.source.latest()?;
        if manifest::version(&latest)? <= manifest::version(installed)? {
            status(
                Phase::UpToDate,
                None,
                &format!("BMuster {installed} is the newest release."),
            )?;
            return Ok(Outcome::UpToDate);
        }
        status(
            Phase::Downloading,
            Some(&latest),
            &format!("Downloading and checking BMuster {latest}"),
        )?;
        let bytes = read_limited(
            self.source
                .open(&latest, &manifest::manifest_name(self.target))?,
            MAX_MANIFEST,
        )?;
        let verified = manifest::verify(&bytes, self.keys, self.target, installed)?;
        if verified.version != latest {
            bail!(
                "the signed manifest names {}, not {latest}",
                verified.version
            );
        }
        download::stage(&self.layout.program, &verified, self.source)?;

        status(
            Phase::Switching,
            Some(&latest),
            &format!("Stopping BMuster {installed} and switching to {latest}"),
        )?;
        self.service.stop()?;
        let backup = files::backup_database(self.layout, installed, &latest)?;
        let mut switch = Switch {
            from: installed.to_string(),
            to: latest.clone(),
            step: Step::Switching,
            nonce: files::new_nonce()?,
            rollback_compatible: verified.rolls_back_to(installed),
        };
        switch.save(&self.layout.switch_record())?;
        point_current(&self.layout.program, &latest)?;
        let started = self.start_release(&mut switch);
        let reason = match started {
            Ok(()) => self.wait_until_ready(&switch),
            Err(e) => Some(format!("{e:#}")),
        };
        match reason {
            None => {
                files::remove(&self.layout.switch_record())?;
                releases::prune(&self.layout.program, &[&latest, installed])?;
                status(
                    Phase::Healthy,
                    Some(&latest),
                    &format!("BMuster {latest} is running; {installed} is kept for recovery."),
                )?;
                Ok(Outcome::Healthy)
            }
            Some(reason) => self.not_healthy(&mut switch, &reason, backup.as_deref()),
        }
    }

    /// The new release refreshes its service definitions, then starts.
    fn start_release(&self, switch: &mut Switch) -> Result<()> {
        self.service
            .refresh(&release_dir(&self.layout.program, &switch.to))?;
        switch.step = Step::Starting;
        switch.save(&self.layout.switch_record())?;
        files::remove(&self.layout.ready_file())?;
        self.service.start()
    }

    /// `None` when the new app reported ready, else why not.
    fn wait_until_ready(&self, switch: &Switch) -> Option<String> {
        let deadline = Instant::now() + self.health_window;
        loop {
            if files::is_ready(self.layout, &switch.nonce, &switch.to) {
                return None;
            }
            if Instant::now() >= deadline {
                return Some(format!(
                    "BMuster {} did not report ready within {} s",
                    switch.to,
                    self.health_window.as_secs()
                ));
            }
            std::thread::sleep(POLL);
        }
    }

    fn not_healthy(
        &self,
        switch: &mut Switch,
        reason: &str,
        backup: Option<&Path>,
    ) -> Result<Outcome> {
        let (from, to) = (switch.from.clone(), switch.to.clone());
        if switch.rollback_compatible {
            switch.step = Step::RollingBack;
            switch.save(&self.layout.switch_record())?;
            self.service.stop()?;
            point_current(&self.layout.program, &from)?;
            self.service
                .refresh(&release_dir(&self.layout.program, &from))?;
            files::remove(&self.layout.ready_file())?;
            self.service.start()?;
            files::remove(&self.layout.switch_record())?;
            files::write_status(
                self.layout,
                Phase::RolledBack,
                Some(&from),
                Some(&to),
                &format!(
                    "{reason}. BMuster {from} runs again; {to} declares it can use the same \
                     database, which was kept."
                ),
            )?;
            return Ok(Outcome::RolledBack);
        }
        self.service.stop()?;
        files::remove(&self.layout.switch_record())?;
        files::write_status(
            self.layout,
            Phase::Failed,
            Some(&from),
            Some(&to),
            &recovery_instructions(self.layout, reason, &from, &to, backup),
        )?;
        Ok(Outcome::Failed)
    }

    /// Finishes or undoes an interrupted update; false when there was none.
    /// The rules depend only on the recorded step, so running it twice is
    /// the same as running it once.
    fn recover_if_needed(&self, at_boot: bool) -> Result<bool> {
        let path = self.layout.switch_record();
        let Some(switch) = Switch::load(&path)? else {
            return Ok(false);
        };
        if !at_boot {
            self.service.stop()?;
        }
        let (from, to) = (switch.from.as_str(), switch.to.as_str());
        let (keep, phase, message) = match (switch.step, switch.rollback_compatible) {
            (Step::Switching, _) => (
                from,
                Phase::Failed,
                format!(
                    "The update to {to} was interrupted before it started; BMuster {from} \
                     still runs on its own database."
                ),
            ),
            (Step::Starting, true) | (Step::RollingBack, _) => (
                from,
                Phase::RolledBack,
                format!(
                    "The update to {to} was interrupted before it proved healthy; BMuster \
                     {from} runs again ({to} declares it can use the same database)."
                ),
            ),
            (Step::Starting, false) => (
                to,
                Phase::Failed,
                format!(
                    "The update to {to} was interrupted while it started. {to} stays, \
                     because {from} may not run on the database it changed; check that \
                     the console works."
                ),
            ),
        };
        point_current(&self.layout.program, keep)?;
        files::remove(&path)?;
        files::write_status(self.layout, phase, Some(from), Some(to), &message)?;
        if !at_boot {
            files::remove(&self.layout.ready_file())?;
            self.service.start()?;
        }
        Ok(true)
    }
}

fn recovery_instructions(
    layout: &Layout,
    reason: &str,
    from: &str,
    to: &str,
    backup: Option<&Path>,
) -> String {
    let copy = backup.map_or_else(
        || "There was no database to copy.".to_string(),
        |path| {
            format!(
                "The database from before the update is copied at {}.",
                path.display()
            )
        },
    );
    format!(
        "{reason}. BMuster {to} does not declare that {from} can run on the database it \
         may have changed, so the server is stopped rather than rolled back. {copy} To go \
         back: restore that copy as {}, point {} at {}, and start the service. Or install a \
         fixed release with the installer.",
        layout.database().display(),
        layout.program.join(releases::CURRENT).display(),
        release_dir(&layout.program, from).display(),
    )
}

#[cfg(test)]
mod tests;
