//! Linux install: binary in /opt/bmuster, data in /var/lib/bmuster, a
//! systemd unit that runs `bmuster-agent launch` as root. The launcher runs
//! the agent from /var/lib/bmuster/versions/current (SPEC-AGENT-UPDATES).

use crate::client::TlsMode;
use crate::identity::{self, EnrolOptions};
use crate::paths;
use anyhow::{bail, Context as _, Result};
use bmuster_protocol::ServerTrust;
use bmuster_service::systemd::{require_root, require_systemd, Unit};
use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::process::Command;

const INSTALL_DIR: &str = "/opt/bmuster";
const BINARY: &str = "/opt/bmuster/bmuster-agent";
const UNIT: Unit = Unit {
    name: "bmuster-agent.service",
};

/// Exit code `run` uses when the machine was removed; systemd must not
/// restart the agent for it.
pub const REVOKED_EXIT_CODE: u8 = 3;

fn unit_file() -> String {
    format!(
        "\
# Written by `bmuster-agent install`. Remove with `bmuster-agent uninstall`.
[Unit]
Description=BMuster Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart={BINARY} launch
# The launcher restarts the agent itself; it exits only to stop, on a crash,
# or with 3 when the machine was removed.
Restart=always
RestartSec=10
RestartPreventExitStatus={REVOKED_EXIT_CODE}
UMask=0077
# Terminal, command and files sessions run as their own transient services
# (systemd-run), outside this sandbox (SPEC-SESSION-UNITS). systemd-run
# reaches the service manager through its socket in /run, which a read-only
# mount still allows, so the hardening below needs no exception for it.
Environment=BMUSTER_SESSIONS=systemd

# Hardening of the agent itself.
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/bmuster
ProtectHome=read-only
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

[Install]
WantedBy=multi-user.target
"
    )
}

pub fn require_admin() -> Result<()> {
    require_root()
}

fn copy_binary(source: Option<&Path>) -> Result<()> {
    let current = match source {
        Some(path) => path.to_path_buf(),
        None => std::env::current_exe().context("could not find this program's path")?,
    };
    fs::create_dir_all(INSTALL_DIR).with_context(|| format!("could not create {INSTALL_DIR}"))?;
    fs::set_permissions(INSTALL_DIR, fs::Permissions::from_mode(0o755))?;
    if current.canonicalize().ok() == Path::new(BINARY).canonicalize().ok() {
        return Ok(());
    }
    let temp = format!("{BINARY}.new");
    fs::copy(&current, &temp)
        .with_context(|| format!("could not copy {} to {temp}", current.display()))?;
    fs::set_permissions(&temp, fs::Permissions::from_mode(0o755))?;
    fs::rename(&temp, BINARY).with_context(|| format!("could not move {temp} to {BINARY}"))?;
    Ok(())
}

pub fn install(url: &str, code: &str, name: Option<&str>, trust: ServerTrust) -> Result<()> {
    require_root()?;
    require_systemd()?;
    let data_dir = paths::default_data_dir()?;
    // A fresh install replaces any earlier agent completely (service, program,
    // identity), so a half-finished or old install never gets in the way.
    let staged = if UNIT.exists() || Path::new(INSTALL_DIR).exists() || data_dir.exists() {
        log::info!(
            "Found an earlier BMuster agent on this machine; removing it before installing."
        );
        // This program may itself live in INSTALL_DIR, which uninstall deletes.
        let staged =
            std::env::temp_dir().join(format!("bmuster-agent-install-{}", std::process::id()));
        let current = std::env::current_exe().context("could not find this program's path")?;
        fs::copy(&current, &staged).with_context(|| {
            format!(
                "could not copy {} to {}",
                current.display(),
                staged.display()
            )
        })?;
        uninstall(true)?;
        Some(staged)
    } else {
        None
    };
    let copied = copy_binary(staged.as_deref());
    if let Some(path) = &staged {
        let _ = fs::remove_file(path);
    }
    copied?;
    log::info!("Copied the agent to {BINARY}");
    identity::enrol(
        &data_dir,
        &EnrolOptions {
            url,
            code,
            name,
            tls: TlsMode::Checked(trust),
        },
    )?;
    UNIT.install(&unit_file())?;
    log::info!("Installed and started {}.", UNIT.name);
    Ok(())
}

pub fn uninstall(purge: bool) -> Result<()> {
    require_root()?;
    if UNIT.remove()? {
        log::info!("Removed {}.", UNIT.name);
    }
    if Path::new(INSTALL_DIR).exists() {
        fs::remove_dir_all(INSTALL_DIR)
            .with_context(|| format!("could not remove {INSTALL_DIR}"))?;
        log::info!("Removed {INSTALL_DIR}.");
    }
    let data_dir = paths::default_data_dir()?;
    crate::updates::remove_versions(&data_dir)?;
    if purge {
        if data_dir.exists() {
            fs::remove_dir_all(&data_dir)
                .with_context(|| format!("could not remove {}", data_dir.display()))?;
            log::info!("Removed {} (identity and key).", data_dir.display());
        }
    } else if data_dir.exists() {
        log::info!(
            "Kept {} (identity and key); add --purge to remove it.",
            data_dir.display()
        );
    }
    Ok(())
}

/// Stops the service if it runs; returns whether it was running (`rejoin`).
pub fn stop_service() -> Result<bool> {
    UNIT.stop_if_active()
}

pub fn start_service() -> Result<()> {
    UNIT.start()
}

/// The local page's Uninstall, from inside the service: the unit's sandbox
/// (ProtectSystem=strict) cannot remove the unit or the program, and
/// stopping the service would end this process part-way. So systemd runs
/// `uninstall --purge` as its own short-lived unit, three seconds from now,
/// after the page has replied.
pub fn schedule_uninstall() -> Result<()> {
    let program = std::env::current_exe().context("could not find this program's path")?;
    let status = Command::new("systemd-run")
        .arg("--quiet")
        .arg("--collect")
        .arg("--on-active=3")
        .arg(format!(
            "--unit=bmuster-agent-uninstall-{}",
            std::process::id()
        ))
        .arg(&program)
        .args(["uninstall", "--purge"])
        .status()
        .context("could not run systemd-run")?;
    if !status.success() {
        bail!("systemd-run failed ({status})");
    }
    Ok(())
}

/// One line about the service, for `status`.
pub fn service_state() -> String {
    UNIT.state()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_runs_the_installed_binary_and_spares_revoked_exits() {
        let unit = unit_file();
        assert!(unit.contains("ExecStart=/opt/bmuster/bmuster-agent launch\n"));
        assert!(unit.contains("Restart=always\n"));
        assert!(unit.contains("RestartPreventExitStatus=3\n"));
        assert!(unit.contains("ReadWritePaths=/var/lib/bmuster\n"));
    }

    #[test]
    fn sessions_run_as_transient_units_outside_the_sandbox() {
        let unit = unit_file();
        assert!(unit.contains("Environment=BMUSTER_SESSIONS=systemd\n"));
        assert!(unit.contains("ProtectSystem=strict\n"));
        assert!(unit.contains("ProtectHome=read-only\n"));
    }
}
