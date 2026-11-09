//! Linux install: the rescue copy and the versions in /opt/bmuster, data in
//! /var/lib/bmuster, a systemd unit that runs the current version's own
//! `bmuster-agent launch` as root from /opt/bmuster/versions/current
//! (SPEC-AGENT-UPDATES, SPEC-SERVER-UPDATES, SPEC-SESSION-UNITS Version 3:
//! systemd may not run programs from /var/lib). If that fails to start three times in five
//! minutes, `bmuster-agent-rescue.service` runs the rescue copy's `rescue`.

use crate::client::TlsMode;
use crate::identity::{self, EnrolOptions};
use crate::paths;
use crate::{rescue, updates};
use anyhow::{bail, Context as _, Result};
use bmuster_protocol::ServerTrust;
use bmuster_service::systemd::{require_root, require_systemd, systemctl, Unit};
use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::process::Command;

const INSTALL_DIR: &str = "/opt/bmuster";
/// The rescue copy: the installer's binary, refreshed after a day of health.
const BINARY: &str = "/opt/bmuster/bmuster-agent";
/// What the service runs: the current version (`updates::Layout`), under
/// /opt, where systemd may run programs (SPEC-SESSION-UNITS, Version 3).
const CURRENT_BINARY: &str = paths::CURRENT_PROGRAM;
const UNIT: Unit = Unit {
    name: "bmuster-agent.service",
};
const RESCUE: Unit = Unit {
    name: "bmuster-agent-rescue.service",
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
# A version whose launcher cannot start is rolled back by the rescue copy.
StartLimitIntervalSec=300
StartLimitBurst=3
OnFailure={rescue}

[Service]
Type=simple
ExecStart={CURRENT_BINARY} launch
# The launcher restarts the agent itself; it exits only to stop, on a crash,
# or with 3 when the machine was removed (not a failure: no rescue).
Restart=always
RestartSec=10
RestartPreventExitStatus={REVOKED_EXIT_CODE}
SuccessExitStatus={REVOKED_EXIT_CODE}
UMask=0077
RuntimeDirectory=bmuster
RuntimeDirectoryMode=0755
# Terminal, command and files sessions run as their own transient services
# (systemd-run), outside this sandbox (SPEC-SESSION-UNITS). systemd-run
# reaches the service manager through its socket in /run, which a read-only
# mount still allows, so the hardening below needs no exception for it.
Environment=BMUSTER_SESSIONS=systemd

# Hardening of the agent itself. It writes its data and, when it updates,
# its program versions under /opt/bmuster (systemd may run programs there).
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=/var/lib/bmuster /opt/bmuster
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
",
        rescue = RESCUE.name
    )
}

/// Run by systemd when the agent's unit fails: the rescue copy puts the
/// previous version back and starts the agent again.
fn rescue_unit_file() -> String {
    format!(
        "\
# Written by `bmuster-agent install`. Started by {unit} when it fails.
[Unit]
Description=BMuster Agent rescue (roll back a version that cannot start)

[Service]
Type=oneshot
ExecStart={BINARY} rescue
",
        unit = UNIT.name
    )
}

fn write_unit_file(unit: &Unit, text: &str) -> Result<()> {
    fs::write(unit.path(), text)
        .with_context(|| format!("could not write {}", unit.path().display()))?;
    fs::set_permissions(unit.path(), fs::Permissions::from_mode(0o644))?;
    Ok(())
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
    log::info!("Copied the agent to {BINARY} (the rescue copy)");
    identity::enrol(
        &data_dir,
        &EnrolOptions {
            url,
            code,
            name,
            tls: TlsMode::Checked(trust),
        },
    )?;
    let bytes = fs::read(BINARY).with_context(|| format!("could not read {BINARY}"))?;
    updates::seed_current(&updates::Layout::new(&data_dir), &bytes, updates::VERSION)?;
    rescue::record_version(&data_dir, updates::VERSION)?;
    crate::tray::linux::install()?;
    write_unit_file(&RESCUE, &rescue_unit_file())?;
    UNIT.install(&unit_file())?;
    log::info!("Installed and started {}.", UNIT.name);
    Ok(())
}

pub fn uninstall(purge: bool) -> Result<()> {
    require_root()?;
    crate::tray::linux::uninstall()?;
    if UNIT.remove()? {
        log::info!("Removed {}.", UNIT.name);
    }
    // Started only on a failure, so there is nothing to disable.
    if RESCUE.exists() {
        fs::remove_file(RESCUE.path())
            .with_context(|| format!("could not remove {}", RESCUE.path().display()))?;
        systemctl(&["daemon-reload"])?;
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

/// After `rescue`: systemd gave up on the unit, so it is reset and started
/// (without waiting: this runs inside the rescue unit).
pub fn finish_rescue() -> Result<()> {
    let _ = systemctl(&["reset-failed", UNIT.name]);
    systemctl(&["start", "--no-block", UNIT.name])
}

/// The program every unit the worker starts runs: the current version
/// under /opt (systemd may not run one from /var/lib). An install that has
/// not moved its program files there yet has none.
fn current_program() -> Result<&'static Path> {
    let program = Path::new(CURRENT_BINARY);
    if !program.exists() {
        bail!(
            "{} is missing: the program files have not moved to /opt/bmuster yet",
            program.display()
        );
    }
    Ok(program)
}

/// The agent's unit files and their text, for `move_to_opt`.
pub fn unit_files() -> [(std::path::PathBuf, String); 2] {
    [
        (UNIT.path(), unit_file()),
        (RESCUE.path(), rescue_unit_file()),
    ]
}

/// The rescue copy, for `move_to_opt`.
pub fn rescue_copy() -> std::path::PathBuf {
    std::path::PathBuf::from(BINARY)
}

/// The agent's own unit, for `move_to_opt`'s restart.
pub const UNIT_NAME: &str = UNIT.name;

/// From the worker (inside the service's sandbox, where /etc is
/// read-only): runs `refresh-rescue` as its own short-lived unit outside it.
pub fn refresh_rescue_copy() -> Result<()> {
    run_transient(refresh_command(current_program()?))
}

fn refresh_command(program: &Path) -> Command {
    let mut command = Command::new("systemd-run");
    command
        .arg("--quiet")
        .arg("--collect")
        .arg(format!(
            "--unit=bmuster-agent-refresh-{}",
            std::process::id()
        ))
        .arg(program)
        .arg("refresh-rescue");
    command
}

fn run_transient(mut command: Command) -> Result<()> {
    let status = command.status().context("could not run systemd-run")?;
    if !status.success() {
        bail!("systemd-run failed ({status})");
    }
    Ok(())
}

/// `refresh-rescue`: the current version becomes the rescue copy, and the
/// units are brought up to this version's (which also moves an install
/// from before the rescue copy onto it, from its next start).
pub fn refresh_service() -> Result<()> {
    require_root()?;
    let program = std::env::current_exe().context("could not find this program's path")?;
    let data_dir = paths::default_data_dir()?;
    rescue::refresh(&data_dir, &program, Path::new(BINARY), updates::VERSION)?;
    log::info!("Version {} is the rescue copy now.", updates::VERSION);
    let mut changed = false;
    for (unit, text) in [(&UNIT, unit_file()), (&RESCUE, rescue_unit_file())] {
        if fs::read_to_string(unit.path()).ok().as_deref() != Some(text.as_str()) {
            write_unit_file(unit, &text)?;
            changed = true;
        }
    }
    if changed {
        systemctl(&["daemon-reload"])?;
        log::info!("Updated the agent's units; they apply from the next start.");
    }
    Ok(())
}

/// The local page's Uninstall, from inside the service: the unit's sandbox
/// (ProtectSystem=strict) cannot remove the unit or the program, and
/// stopping the service would end this process part-way. So systemd runs
/// `uninstall --purge` as its own short-lived unit, three seconds from now,
/// after the page has replied.
pub fn schedule_uninstall() -> Result<()> {
    run_transient(uninstall_command(current_program()?))
}

fn uninstall_command(program: &Path) -> Command {
    let mut command = Command::new("systemd-run");
    command
        .arg("--quiet")
        .arg("--collect")
        .arg("--on-active=3")
        .arg(format!(
            "--unit=bmuster-agent-uninstall-{}",
            std::process::id()
        ))
        .arg(program)
        .args(["uninstall", "--purge"]);
    command
}

/// One line about the service, for `status`.
pub fn service_state() -> String {
    UNIT.state()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unit_runs_the_current_version_and_spares_revoked_exits() {
        let unit = unit_file();
        // SPEC-SESSION-UNITS O2: systemd runs the agent from /opt.
        assert!(unit.contains("ExecStart=/opt/bmuster/versions/current/bmuster-agent launch\n"));
        assert_eq!(
            Path::new(CURRENT_BINARY),
            updates::Layout::new(Path::new("/var/lib/bmuster")).binary(updates::Slot::Current)
        );
        assert!(!unit.contains("/var/lib/bmuster/versions"));
        assert!(rescue_unit_file().contains("ExecStart=/opt/bmuster/"));
        // The rescue refresh and the local page's uninstall run as
        // transient units of the current version under /opt.
        assert_eq!(
            CURRENT_BINARY,
            "/opt/bmuster/versions/current/bmuster-agent"
        );
        for command in [
            refresh_command(Path::new(CURRENT_BINARY)),
            uninstall_command(Path::new(CURRENT_BINARY)),
        ] {
            assert!(command.get_args().any(|arg| arg == CURRENT_BINARY));
        }
        assert!(unit.contains("Restart=always\n"));
        assert!(unit.contains("RestartPreventExitStatus=3\n"));
        // Removed machines stop without a rescue.
        assert!(unit.contains("SuccessExitStatus=3\n"));
    }

    /// SPEC-SESSION-UNITS O3: the agent may write its data and its program
    /// versions, nothing else, and the rest of the sandbox is as it was.
    #[test]
    fn sandbox_writes_only_data_and_program() {
        let unit = unit_file();
        let writable: Vec<&str> = unit
            .lines()
            .filter(|line| line.starts_with("ReadWritePaths="))
            .collect();
        assert_eq!(writable, ["ReadWritePaths=/var/lib/bmuster /opt/bmuster"]);
        let hardening: Vec<&str> = unit
            .lines()
            .skip_while(|line| !line.starts_with("NoNewPrivileges="))
            .take_while(|line| !line.is_empty())
            .collect();
        assert_eq!(
            hardening,
            [
                "NoNewPrivileges=yes",
                "ProtectSystem=strict",
                "ReadWritePaths=/var/lib/bmuster /opt/bmuster",
                "ProtectHome=read-only",
                "PrivateTmp=yes",
                "ProtectKernelTunables=yes",
                "ProtectKernelModules=yes",
                "ProtectKernelLogs=yes",
                "ProtectControlGroups=yes",
                "ProtectClock=yes",
                "ProtectHostname=yes",
                "RestrictSUIDSGID=yes",
                "RestrictRealtime=yes",
                "RestrictNamespaces=yes",
                "LockPersonality=yes",
                "MemoryDenyWriteExecute=yes",
                "SystemCallArchitectures=native",
                "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
            ]
        );
        for (path, _) in unit_files() {
            assert!(path.starts_with("/etc/systemd/system"));
        }
    }

    #[test]
    fn a_failing_start_runs_the_rescue_copy() {
        let unit = unit_file();
        assert!(unit.contains(
            "StartLimitIntervalSec=300\nStartLimitBurst=3\nOnFailure=bmuster-agent-rescue.service\n"
        ));
        let rescue = rescue_unit_file();
        assert!(rescue.contains("Type=oneshot\n"));
        assert!(rescue.contains("ExecStart=/opt/bmuster/bmuster-agent rescue\n"));
    }

    #[test]
    fn sessions_run_as_transient_units_outside_the_sandbox() {
        let unit = unit_file();
        assert!(unit.contains("Environment=BMUSTER_SESSIONS=systemd\n"));
        assert!(unit.contains("ProtectSystem=strict\n"));
        assert!(unit.contains("ProtectHome=read-only\n"));
        // Units connect back over /run/bmuster/connect (SPEC-SESSION-UNITS,
        // Version 2): the runtime folder is the one writable place under
        // /run, and the sandbox needs nothing more.
        assert!(unit.contains("RuntimeDirectory=bmuster\n"));
        assert!(unit.contains("ReadWritePaths=/var/lib/bmuster /opt/bmuster\n"));
        assert!(unit.contains("RestrictAddressFamilies=AF_UNIX "));
    }
}
