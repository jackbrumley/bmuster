//! Linux: a systemd unit that runs `bmuster-server run` as the system user
//! `bmuster-server`, which owns only the data folder (SPEC-SERVER-INSTALL I5).

use crate::layout::Layout;
use anyhow::{bail, Context as _, Result};
use bmuster_service::systemd::{require_root, require_systemd, Unit};
use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::process::Command;

const UNIT: Unit = Unit {
    name: "bmuster-server.service",
};
const USER: &str = "bmuster-server";

pub fn unit_file(layout: &Layout) -> String {
    let launcher = layout.launcher();
    let data = layout.data.display();
    format!(
        "\
# Written by `bmuster-server install`. Remove with `bmuster-server uninstall`.
[Unit]
Description=BMuster Server
Documentation=https://bmuster.com
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User={USER}
Group={USER}
ExecStart={launcher} run --data-dir {data}
Restart=on-failure
RestartSec=5
# server.ts closes open connections within 10 s of SIGTERM.
TimeoutStopSec=20
UMask=0077
# Lets PORT be below 1024 (for example 443) without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

# Hardening. Only the data folder is writable. MemoryDenyWriteExecute is
# left out on purpose: Node's JIT compiler needs it.
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths={data}
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
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
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

[Install]
WantedBy=multi-user.target
",
        launcher = launcher.display()
    )
}

pub fn require_admin() -> Result<()> {
    require_root()
}

fn run(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program)
        .args(args)
        .status()
        .with_context(|| format!("could not run {program}"))?;
    if !status.success() {
        bail!("{program} {} failed ({status})", args.join(" "));
    }
    Ok(())
}

fn user_exists() -> bool {
    Command::new("id")
        .args(["-u", USER])
        .output()
        .is_ok_and(|output| output.status.success())
}

/// The system user, the data folder handed to it, and the started unit.
pub fn install_service(layout: &Layout) -> Result<()> {
    require_systemd()?;
    if !user_exists() {
        let home = layout.data.to_string_lossy();
        run(
            "useradd",
            &[
                "--system",
                "--user-group",
                "--no-create-home",
                "--home-dir",
                &home,
                "--shell",
                "/usr/sbin/nologin",
                USER,
            ],
        )?;
        println!("Created the system user {USER}.");
    }
    let data = layout.data.to_string_lossy();
    run("chown", &["-R", &format!("{USER}:{USER}"), &data])?;
    fs::set_permissions(&layout.data, fs::Permissions::from_mode(0o700))?;
    UNIT.install(&unit_file(layout))?;
    println!("Installed and started {}.", UNIT.name);
    Ok(())
}

/// Stops the service before its program folder is replaced.
pub fn stop_service() -> Result<bool> {
    UNIT.stop_if_active()
}

pub fn service_installed() -> bool {
    UNIT.exists()
}

pub fn remove_service() -> Result<()> {
    if UNIT.remove()? {
        println!("Removed {}.", UNIT.name);
    }
    Ok(())
}

/// After `--purge`: the system user goes too.
pub fn remove_user() -> Result<()> {
    if user_exists() {
        run("userdel", &[USER])?;
        println!("Removed the system user {USER}.");
    }
    Ok(())
}

/// Deletes the program folder; Linux lets a running program delete its own file.
pub fn remove_program(layout: &Layout) -> Result<()> {
    fs::remove_dir_all(&layout.program)
        .with_context(|| format!("could not remove {}", layout.program.display()))
}

pub fn service_state() -> String {
    UNIT.state()
}

/// Where Node's output goes, and how to find the setup code in it.
pub fn log_hint(_layout: &Layout) -> String {
    "journalctl -u bmuster-server (setup code: journalctl -u bmuster-server | grep 'setup code' | tail -n 1)".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn the_unit_runs_the_launcher_as_its_own_user_and_writes_only_the_data() {
        let unit = unit_file(&Layout {
            program: PathBuf::from("/opt/bmuster-server"),
            data: PathBuf::from("/var/lib/bmuster-server"),
        });
        assert!(unit.contains(
            "ExecStart=/opt/bmuster-server/bmuster-server run --data-dir /var/lib/bmuster-server\n"
        ));
        assert!(unit.contains("User=bmuster-server\nGroup=bmuster-server\n"));
        assert!(unit.contains("Restart=on-failure\n"));
        assert!(unit.contains("ProtectSystem=strict\nReadWritePaths=/var/lib/bmuster-server\n"));
        assert!(unit.contains("AmbientCapabilities=CAP_NET_BIND_SERVICE\n"));
        assert!(unit.contains("WantedBy=multi-user.target\n"));
        // Node's JIT cannot run with it.
        assert!(!unit.contains("\nMemoryDenyWriteExecute"));
        // Never the agent's names or folders.
        assert!(!unit.contains("/opt/bmuster/") && !unit.contains("/var/lib/bmuster\n"));
    }

    #[test]
    fn a_custom_prefix_and_data_folder_reach_the_unit() {
        let unit = unit_file(&Layout {
            program: PathBuf::from("/srv/bms"),
            data: PathBuf::from("/srv/bms-data"),
        });
        assert!(unit.contains("ExecStart=/srv/bms/bmuster-server run --data-dir /srv/bms-data\n"));
        assert!(unit.contains("ReadWritePaths=/srv/bms-data\n"));
    }
}
