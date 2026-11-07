//! Linux install: binary in /opt/bmuster, data in /var/lib/bmuster, a
//! systemd unit that runs `bmuster-agent run` as root.

use crate::client::TlsMode;
use crate::identity::{self, EnrolOptions};
use crate::paths;
use anyhow::{bail, Context as _, Result};
use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::process::Command;

const INSTALL_DIR: &str = "/opt/bmuster";
const BINARY: &str = "/opt/bmuster/bmuster-agent";
const UNIT_NAME: &str = "bmuster-agent.service";
const UNIT_PATH: &str = "/etc/systemd/system/bmuster-agent.service";

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
ExecStart={BINARY} run
Restart=always
RestartSec=10
RestartPreventExitStatus={REVOKED_EXIT_CODE}
UMask=0077

# Hardening. Sessions (SPEC-SESSIONS) will need shells and the display, and
# will relax only what they must.
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

fn require_root() -> Result<()> {
    // SAFETY: geteuid has no preconditions and cannot fail.
    if unsafe { libc::geteuid() } != 0 {
        bail!("this command needs root; run it with sudo");
    }
    Ok(())
}

fn require_systemd() -> Result<()> {
    if !Path::new("/run/systemd/system").is_dir() {
        bail!("systemd is not running on this machine; BMuster needs it to run the agent");
    }
    Ok(())
}

fn systemctl(args: &[&str]) -> Result<()> {
    let status = Command::new("systemctl")
        .args(args)
        .status()
        .with_context(|| format!("could not run systemctl {}", args.join(" ")))?;
    if !status.success() {
        bail!("systemctl {} failed ({status})", args.join(" "));
    }
    Ok(())
}

fn copy_binary() -> Result<()> {
    let current = std::env::current_exe().context("could not find this program's path")?;
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

pub fn install(url: &str, code: &str, name: Option<&str>) -> Result<()> {
    require_root()?;
    require_systemd()?;
    if Path::new(UNIT_PATH).exists() {
        bail!("BMuster is already installed ({UNIT_PATH} exists); run `bmuster-agent uninstall` first");
    }
    let data_dir = paths::default_data_dir()?;
    copy_binary()?;
    log::info!("Copied the agent to {BINARY}");
    identity::enrol(
        &data_dir,
        &EnrolOptions {
            url,
            code,
            name,
            tls: TlsMode::Verify,
        },
    )?;
    fs::write(UNIT_PATH, unit_file()).with_context(|| format!("could not write {UNIT_PATH}"))?;
    fs::set_permissions(UNIT_PATH, fs::Permissions::from_mode(0o644))?;
    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", "--now", UNIT_NAME])?;
    log::info!("Installed and started {UNIT_NAME}.");
    Ok(())
}

pub fn uninstall(purge: bool) -> Result<()> {
    require_root()?;
    if Path::new(UNIT_PATH).exists() {
        systemctl(&["disable", "--now", UNIT_NAME])?;
        fs::remove_file(UNIT_PATH).with_context(|| format!("could not remove {UNIT_PATH}"))?;
        systemctl(&["daemon-reload"])?;
        log::info!("Removed {UNIT_NAME}.");
    }
    if Path::new(INSTALL_DIR).exists() {
        fs::remove_dir_all(INSTALL_DIR)
            .with_context(|| format!("could not remove {INSTALL_DIR}"))?;
        log::info!("Removed {INSTALL_DIR}.");
    }
    let data_dir = paths::default_data_dir()?;
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

/// One line about the service, for `status`.
pub fn service_state() -> String {
    if !Path::new(UNIT_PATH).exists() {
        return "not installed".into();
    }
    match Command::new("systemctl")
        .args(["is-active", UNIT_NAME])
        .output()
    {
        Ok(output) => String::from_utf8_lossy(&output.stdout).trim().to_string(),
        Err(e) => format!("unknown (could not run systemctl: {e})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_runs_the_installed_binary_and_spares_revoked_exits() {
        let unit = unit_file();
        assert!(unit.contains("ExecStart=/opt/bmuster/bmuster-agent run\n"));
        assert!(unit.contains("Restart=always\n"));
        assert!(unit.contains("RestartPreventExitStatus=3\n"));
        assert!(unit.contains("ReadWritePaths=/var/lib/bmuster\n"));
    }
}
