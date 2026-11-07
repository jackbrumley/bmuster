//! systemd: root and systemd checks, and one unit file's life cycle.

use anyhow::{bail, Context as _, Result};
use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::Command;

pub fn require_root() -> Result<()> {
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { libc::geteuid() } != 0 {
        bail!("this command needs root; run it with sudo");
    }
    Ok(())
}

pub fn require_systemd() -> Result<()> {
    if !Path::new("/run/systemd/system").is_dir() {
        bail!("systemd is not running on this machine; BMuster needs it to run as a service");
    }
    Ok(())
}

pub fn systemctl(args: &[&str]) -> Result<()> {
    let status = Command::new("systemctl")
        .args(args)
        .status()
        .with_context(|| format!("could not run systemctl {}", args.join(" ")))?;
    if !status.success() {
        bail!("systemctl {} failed ({status})", args.join(" "));
    }
    Ok(())
}

/// A unit in `/etc/systemd/system`, written and removed by its program.
pub struct Unit {
    /// For example `bmuster-agent.service`.
    pub name: &'static str,
}

impl Unit {
    pub fn path(&self) -> PathBuf {
        Path::new("/etc/systemd/system").join(self.name)
    }

    pub fn exists(&self) -> bool {
        self.path().exists()
    }

    /// Writes the unit (0644), reloads systemd, then enables and starts it.
    pub fn install(&self, text: &str) -> Result<()> {
        let path = self.path();
        fs::write(&path, text).with_context(|| format!("could not write {}", path.display()))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644))?;
        systemctl(&["daemon-reload"])?;
        systemctl(&["enable", "--now", self.name])
    }

    /// Stops, disables and deletes the unit; false when there was none.
    pub fn remove(&self) -> Result<bool> {
        let path = self.path();
        if !path.exists() {
            return Ok(false);
        }
        systemctl(&["disable", "--now", self.name])?;
        fs::remove_file(&path).with_context(|| format!("could not remove {}", path.display()))?;
        systemctl(&["daemon-reload"])?;
        Ok(true)
    }

    /// Stops the service if it runs; returns whether it was running.
    pub fn stop_if_active(&self) -> Result<bool> {
        if !self.exists() || self.state() != "active" {
            return Ok(false);
        }
        systemctl(&["stop", self.name])?;
        Ok(true)
    }

    pub fn start(&self) -> Result<()> {
        systemctl(&["start", self.name])
    }

    /// One word from `systemctl is-active`, or "not installed".
    pub fn state(&self) -> String {
        if !self.exists() {
            return "not installed".into();
        }
        match Command::new("systemctl")
            .args(["is-active", self.name])
            .output()
        {
            Ok(output) => String::from_utf8_lossy(&output.stdout).trim().to_string(),
            Err(e) => format!("unknown (could not run systemctl: {e})"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_live_in_etc_systemd_system() {
        let unit = Unit {
            name: "bmuster-test.service",
        };
        assert_eq!(
            unit.path(),
            PathBuf::from("/etc/systemd/system/bmuster-test.service")
        );
    }
}
