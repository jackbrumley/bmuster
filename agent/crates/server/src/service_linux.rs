//! Linux: a systemd unit that runs `<prefix>/current/bmuster-server run` as
//! the system user `bmuster-server`, which owns only the data folder
//! (SPEC-SERVER-INSTALL I5), and the root updater's units
//! (SPEC-SERVER-UPDATES): a path unit that starts the updater when the app
//! writes its request flag, and a boot-time recovery run before the server.

use crate::layout::Layout;
use anyhow::{bail, Context as _, Result};
use bmuster_service::systemd::{require_root, require_systemd, systemctl, Unit};
use std::fs;
use std::os::unix::fs::PermissionsExt as _;
use std::process::Command;

const SERVER: Unit = Unit {
    name: "bmuster-server.service",
};
const UPDATE_PATH: Unit = Unit {
    name: "bmuster-server-update.path",
};
const UPDATER: Unit = Unit {
    name: "bmuster-server-update.service",
};
const RECOVER: Unit = Unit {
    name: "bmuster-server-recover.service",
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
TimeoutStopSec=25
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

/// Starts the updater when the app (which cannot get root) asks.
pub fn update_path_unit(layout: &Layout) -> String {
    format!(
        "\
# Written by `bmuster-server install`. The app's Update now writes the
# flag; its contents are ignored.
[Unit]
Description=BMuster Server update request

[Path]
PathExists={flag}
Unit={UPDATER}

[Install]
WantedBy=multi-user.target
",
        flag = layout.update_flag().display(),
        UPDATER = UPDATER.name,
    )
}

/// The root updater: picks, verifies and installs the newest signed release.
pub fn updater_unit(layout: &Layout) -> String {
    format!(
        "\
# Written by `bmuster-server install`. Started by {path}.
[Unit]
Description=BMuster Server updater
After=network-online.target {recover}
Wants=network-online.target

[Service]
Type=oneshot
ExecStart={launcher} update --prefix {prefix} --data-dir {data}
# A download, the switch and the two-minute health check.
TimeoutStartSec=30min
UMask=0022
",
        path = UPDATE_PATH.name,
        recover = RECOVER.name,
        launcher = layout.launcher().display(),
        prefix = layout.program.display(),
        data = layout.data.display(),
    )
}

/// At boot, before the server: finishes or undoes an interrupted update.
pub fn recover_unit(layout: &Layout) -> String {
    format!(
        "\
# Written by `bmuster-server install`. Runs only after an interrupted update.
[Unit]
Description=BMuster Server update recovery
Before={server}
ConditionPathExists={record}

[Service]
Type=oneshot
ExecStart={launcher} update --recover --prefix {prefix} --data-dir {data}
UMask=0022

[Install]
WantedBy=multi-user.target
",
        server = SERVER.name,
        record = layout.switch_record().display(),
        launcher = layout.launcher().display(),
        prefix = layout.program.display(),
        data = layout.data.display(),
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

fn write_unit(unit: &Unit, text: &str) -> Result<()> {
    let path = unit.path();
    fs::write(&path, text).with_context(|| format!("could not write {}", path.display()))?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o644))?;
    Ok(())
}

/// Writes all four units and enables them; the server itself is not
/// started (the installer and updater start it when they are ready).
pub fn refresh_units(layout: &Layout) -> Result<()> {
    require_systemd()?;
    write_unit(&SERVER, &unit_file(layout))?;
    write_unit(&UPDATE_PATH, &update_path_unit(layout))?;
    write_unit(&UPDATER, &updater_unit(layout))?;
    write_unit(&RECOVER, &recover_unit(layout))?;
    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", SERVER.name, RECOVER.name])?;
    systemctl(&["enable", "--now", UPDATE_PATH.name])
}

/// The system user, the data folder handed to it, and the started units.
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
    refresh_units(layout)?;
    SERVER.start()?;
    println!(
        "Installed and started {}, with automatic updates ({}).",
        SERVER.name, UPDATE_PATH.name
    );
    Ok(())
}

/// Stops the service before its release is switched or replaced.
pub fn stop_service() -> Result<bool> {
    SERVER.stop_if_active()
}

/// Starts the service again, even after systemd gave up restarting it.
pub fn start_service() -> Result<()> {
    let _ = systemctl(&["reset-failed", SERVER.name]);
    SERVER.start()
}

pub fn service_installed() -> bool {
    SERVER.exists()
}

pub fn remove_service() -> Result<()> {
    for unit in [UPDATE_PATH, RECOVER, SERVER] {
        if unit.remove()? {
            println!("Removed {}.", unit.name);
        }
    }
    // Started only by the path unit, so it has nothing to disable.
    if UPDATER.exists() {
        let _ = systemctl(&["stop", UPDATER.name]);
        fs::remove_file(UPDATER.path())
            .with_context(|| format!("could not remove {}", UPDATER.path().display()))?;
        systemctl(&["daemon-reload"])?;
        println!("Removed {}.", UPDATER.name);
    }
    Ok(())
}

/// After `--purge`: the system user goes too (only root can remove it; a
/// `--no-service` install never made one).
pub fn remove_user() -> Result<()> {
    if require_root().is_ok() && user_exists() {
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
    SERVER.state()
}

/// Where Node's output goes, and how to find the setup code in it.
pub fn log_hint(_layout: &Layout) -> String {
    "journalctl -u bmuster-server (setup code: journalctl -u bmuster-server | grep 'setup code' | tail -n 1)".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn installed() -> Layout {
        Layout {
            program: PathBuf::from("/opt/bmuster-server"),
            data: PathBuf::from("/var/lib/bmuster-server"),
        }
    }

    #[test]
    fn the_unit_runs_the_current_release_as_its_own_user_and_writes_only_the_data() {
        let unit = unit_file(&installed());
        assert!(unit.contains(
            "ExecStart=/opt/bmuster-server/current/bmuster-server run --data-dir /var/lib/bmuster-server\n"
        ));
        assert!(unit.contains("User=bmuster-server\nGroup=bmuster-server\n"));
        assert!(unit.contains("Restart=on-failure\n"));
        assert!(unit.contains("ProtectSystem=strict\nReadWritePaths=/var/lib/bmuster-server\n"));
        assert!(unit.contains("NoNewPrivileges=yes\n"));
        assert!(unit.contains("AmbientCapabilities=CAP_NET_BIND_SERVICE\n"));
        assert!(unit.contains("WantedBy=multi-user.target\n"));
        // Node's JIT cannot run with it.
        assert!(!unit.contains("\nMemoryDenyWriteExecute"));
        // Never the agent's names or folders.
        assert!(!unit.contains("/opt/bmuster/") && !unit.contains("/var/lib/bmuster\n"));
    }

    #[test]
    fn the_flag_starts_the_root_updater_and_boot_recovers_first() {
        let layout = installed();
        let path = update_path_unit(&layout);
        assert!(path.contains("PathExists=/var/lib/bmuster-server/update-requested\n"));
        assert!(path.contains("Unit=bmuster-server-update.service\n"));

        let updater = updater_unit(&layout);
        assert!(updater.contains("Type=oneshot\n"));
        assert!(updater.contains(
            "ExecStart=/opt/bmuster-server/current/bmuster-server update --prefix /opt/bmuster-server --data-dir /var/lib/bmuster-server\n"
        ));
        // Root: no User=, and none of the app's sandbox.
        assert!(!updater.contains("User="));

        let recover = recover_unit(&layout);
        assert!(recover.contains("Before=bmuster-server.service\n"));
        assert!(recover.contains("ConditionPathExists=/opt/bmuster-server/update-switch.json\n"));
        assert!(recover.contains(" update --recover --prefix /opt/bmuster-server "));
        assert!(recover.contains("WantedBy=multi-user.target\n"));
    }

    #[test]
    fn a_custom_prefix_and_data_folder_reach_every_unit() {
        let layout = Layout {
            program: PathBuf::from("/srv/bms"),
            data: PathBuf::from("/srv/bms-data"),
        };
        let unit = unit_file(&layout);
        assert!(unit
            .contains("ExecStart=/srv/bms/current/bmuster-server run --data-dir /srv/bms-data\n"));
        assert!(unit.contains("ReadWritePaths=/srv/bms-data\n"));
        assert!(update_path_unit(&layout).contains("PathExists=/srv/bms-data/update-requested\n"));
        assert!(updater_unit(&layout).contains("--prefix /srv/bms --data-dir /srv/bms-data\n"));
        assert!(recover_unit(&layout).contains("ConditionPathExists=/srv/bms/update-switch.json\n"));
    }
}
