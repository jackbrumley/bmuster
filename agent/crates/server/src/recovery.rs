//! `bmuster-server reset-password` and `reset-two-factor`
//! (SPEC-SERVER-INSTALL I15): the way back in when the last admin has lost
//! their password or their authenticator. Both run the release's own
//! `app/account-recovery.js` with the installed server's settings and data,
//! the same code as `npm run admin:reset` and `two-factor:reset` in a
//! checkout, which audits every change with actor system.
//!
//! Only someone who can already read the settings and the database may run
//! them: root or Administrator, or (Unix) the data folder's owner, the
//! service user. Root runs Node as that owner, so any file SQLite makes
//! beside the database stays the server's. The running server is left
//! alone: the app writes through SQLite's write-ahead log and busy timeout,
//! like any second connection, and never takes the server's data lock.

use crate::launcher::app_command;
use crate::layout;
use anyhow::{bail, Context as _, Result};
use std::path::Path;
use std::process::ExitCode;

/// The app entry both commands run (scripts/release/app-entries.ts).
pub const ENTRY: &str = "account-recovery.js";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    ResetPassword,
    ResetTwoFactor,
}

impl Action {
    /// The command account-recovery.js takes, the same word as the launcher's.
    fn name(self) -> &'static str {
        match self {
            Action::ResetPassword => "reset-password",
            Action::ResetTwoFactor => "reset-two-factor",
        }
    }
}

/// Runs the action for `email` from this program's release, against `data`;
/// the app's exit code (0 done, 1 refused) becomes ours.
pub fn run(action: Action, email: &str, data: &Path) -> Result<ExitCode> {
    let release = layout::own_dir()?;
    let entry = release.join("app").join(ENTRY);
    if !entry.exists() {
        bail!(
            "{} is missing; this release cannot reset accounts",
            entry.display()
        );
    }
    let mut command = app_command(&release, data, ENTRY);
    command.arg(action.name()).arg("--email").arg(email);
    allow(&mut command, data)?;
    let env_file = data.join(layout::ENV_FILE);
    if !env_file.exists() {
        bail!(
            "there are no settings at {}; pass the server's --data-dir",
            env_file.display()
        );
    }
    // The app would make an empty database; a wrong folder must change nothing.
    let database = data.join(layout::DATABASE_FILE);
    if !database.exists() {
        bail!(
            "there is no database at {}; pass the server's --data-dir",
            database.display()
        );
    }
    let status = command
        .status()
        .context("could not start the bundled Node application")?;
    Ok(
        match status.code().and_then(|code| u8::try_from(code).ok()) {
            Some(code) => ExitCode::from(code),
            None => ExitCode::FAILURE,
        },
    )
}

/// Who runs Node, from the caller's and the data folder owner's user ids.
#[cfg_attr(not(unix), allow(dead_code))]
#[derive(Debug, PartialEq, Eq)]
enum RunAs {
    /// The caller owns the data folder.
    Caller,
    /// Root, on behalf of the data folder's owner.
    Owner,
    Refused,
}

#[cfg_attr(not(unix), allow(dead_code))]
fn run_as(caller: u32, owner: u32) -> RunAs {
    if caller == owner {
        RunAs::Caller
    } else if caller == 0 {
        RunAs::Owner
    } else {
        RunAs::Refused
    }
}

#[cfg(unix)]
fn allow(command: &mut std::process::Command, data: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt as _;
    use std::os::unix::process::CommandExt as _;
    let folder = std::fs::metadata(data)
        .with_context(|| format!("could not read the data folder {}", data.display()))?;
    // SAFETY: geteuid only reads the process's user id.
    let caller = unsafe { libc::geteuid() };
    match run_as(caller, folder.uid()) {
        RunAs::Caller => Ok(()),
        RunAs::Owner => {
            // Root drops to the owner (and its group) before Node starts;
            // std clears root's supplementary groups too.
            command.uid(folder.uid()).gid(folder.gid());
            Ok(())
        }
        RunAs::Refused => bail!(
            "run this as root (sudo) or as the user that owns {}, the server's service user",
            data.display()
        ),
    }
}

#[cfg(windows)]
fn allow(_command: &mut std::process::Command, _data: &Path) -> Result<()> {
    crate::platform::require_admin()
        .context("run this from an Administrator PowerShell or Command Prompt")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_owner_runs_it_as_themselves_and_root_runs_it_as_the_owner() {
        assert_eq!(run_as(990, 990), RunAs::Caller);
        assert_eq!(run_as(0, 0), RunAs::Caller);
        assert_eq!(run_as(0, 990), RunAs::Owner);
        assert_eq!(run_as(1000, 990), RunAs::Refused);
    }

    #[test]
    fn the_app_gets_the_command_the_email_and_the_installed_settings() {
        let release = Path::new("/opt/bmuster-server/current");
        let data = Path::new("/var/lib/bmuster-server");
        let mut command = app_command(release, data, ENTRY);
        command
            .arg(Action::ResetTwoFactor.name())
            .arg("--email")
            .arg("ada@example.com");
        let arguments: Vec<String> = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();
        let entry = release.join("app").join("account-recovery.js");
        assert_eq!(
            arguments[1..],
            [
                entry.to_string_lossy().into_owned(),
                "reset-two-factor".into(),
                "--email".into(),
                "ada@example.com".into()
            ]
        );
        assert_eq!(Action::ResetPassword.name(), "reset-password");
        assert!(command
            .get_envs()
            .any(|(name, value)| name == "DATABASE_PATH"
                && value == Some(data.join("bmuster.db").as_os_str())));
        // Not the service's deployment settings: the app would ask for the
        // updater's readiness nonce.
        assert!(command
            .get_envs()
            .all(|(name, _)| name != "BMUSTER_DEPLOYMENT"));
    }
}
