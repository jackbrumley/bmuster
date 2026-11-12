//! The machine's display report (SPEC-AGENT-LOGS 3), sent inside the
//! inventory: seat0's active session, the DRM cards and their connected
//! outputs, uinput, NVIDIA mode setting, the portal and GStreamer.
//!
//! The agent runs as root, so it reads only regular files under `/sys`,
//! `/proc` and `/run`, and checks fixed program paths exist; it never opens a
//! device node or a named pipe (the gpus.rs rule), and runs nothing.

use bmuster_protocol::DisplayReport;
#[cfg(target_os = "linux")]
use bmuster_protocol::{
    DrmCard, DrmConnector, LauncherVersion, LinuxDisplay, LockedHint, NvidiaModeset, Programs,
    SeLinux, SeatSession, Uinput,
};
#[cfg(target_os = "linux")]
use std::path::{Path, PathBuf};

/// Set by the launcher for the worker it starts.
pub const LAUNCHER_VERSION_ENV: &str = "BMUSTER_AGENT_LAUNCHER_VERSION";

/// The report for this machine.
pub fn report() -> DisplayReport {
    #[cfg(target_os = "linux")]
    {
        let launcher = match std::env::var(LAUNCHER_VERSION_ENV) {
            Ok(version) if !version.is_empty() => LauncherVersion::Known { version },
            _ => LauncherVersion::None,
        };
        linux_report(
            &Sources::system(),
            env!("BMUSTER_VERSION").to_string(),
            launcher,
        )
    }
    #[cfg(windows)]
    {
        DisplayReport::Windows {
            console: crate::inventory::signed_in_user(),
            system: windows_system(),
        }
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        DisplayReport::Unsupported
    }
}

/// Build, edition, the console session, the DXGI outputs and the SAS policy
/// (SPEC-DIAGNOSTICS 4). The outputs come from a helper in the console
/// session (`console_outputs`), kept for an hour. Whether the secure desktop
/// is up is live state, not inventory, so it stays `unknown` here (the
/// helper's timeline steps say it).
#[cfg(windows)]
fn windows_system() -> bmuster_protocol::WindowsSystem {
    use bmuster_desktop::winsession::{console, follow::NO_CONSOLE_SESSION};
    use bmuster_protocol::{ConsoleSession, SasPolicy, SecureDesktop, WindowsSystem};
    let version =
        windows_registry::LOCAL_MACHINE.open(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
    let text = |name: &str| {
        version
            .as_ref()
            .ok()
            .and_then(|key| key.get_string(name).ok())
            .unwrap_or_default()
    };
    let build = match (
        text("CurrentBuild"),
        version
            .as_ref()
            .ok()
            .and_then(|key| key.get_u32("UBR").ok()),
    ) {
        (build, Some(ubr)) if !build.is_empty() => format!("{build}.{ubr}"),
        (build, _) => build,
    };
    let session = console::active_console_session();
    WindowsSystem::Reported {
        build,
        edition: text("EditionID"),
        console_session: if session == NO_CONSOLE_SESSION {
            ConsoleSession::None
        } else {
            ConsoleSession::Attached {
                id: session,
                state: console::session_state(session),
            }
        },
        secure_desktop: SecureDesktop::Unknown,
        outputs: crate::console_outputs::console_outputs(session),
        sas_policy: match crate::checks::windows::sas_value() {
            Some(value) => SasPolicy::Set { value },
            None => SasPolicy::NotSet,
        },
    }
}

/// Where the files are: `/` on a machine, a folder in tests.
#[cfg(target_os = "linux")]
struct Sources {
    root: PathBuf,
}

#[cfg(target_os = "linux")]
const PORTAL_PATHS: [&str; 3] = [
    "usr/libexec/xdg-desktop-portal",
    "usr/lib/xdg-desktop-portal",
    "usr/lib/x86_64-linux-gnu/xdg-desktop-portal",
];
#[cfg(target_os = "linux")]
const GSTREAMER_PATHS: [&str; 2] = ["usr/bin/gst-launch-1.0", "bin/gst-launch-1.0"];
#[cfg(target_os = "linux")]
const PIPEWIRESRC_PATHS: [&str; 4] = [
    "usr/lib64/gstreamer-1.0/libgstpipewire.so",
    "usr/lib/gstreamer-1.0/libgstpipewire.so",
    "usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstpipewire.so",
    "usr/lib/aarch64-linux-gnu/gstreamer-1.0/libgstpipewire.so",
];
/// The most of one file read: sysfs and logind files are small.
#[cfg(target_os = "linux")]
const MAX_FILE_BYTES: u64 = 64 * 1024;

#[cfg(target_os = "linux")]
impl Sources {
    fn system() -> Self {
        Self {
            root: PathBuf::from("/"),
        }
    }

    fn path(&self, relative: &str) -> PathBuf {
        self.root.join(relative)
    }

    /// A regular file's text (following symlinks, as sysfs needs); nothing
    /// else is opened.
    fn read(&self, path: &Path) -> Option<String> {
        use std::io::Read as _;
        if !std::fs::metadata(path).ok()?.is_file() {
            return None;
        }
        let mut text = String::new();
        std::fs::File::open(path)
            .ok()?
            .take(MAX_FILE_BYTES)
            .read_to_string(&mut text)
            .ok()?;
        Some(text)
    }

    fn exists(&self, relative: &str) -> bool {
        std::fs::metadata(self.path(relative)).is_ok()
    }

    fn any_file(&self, relatives: &[&str]) -> bool {
        relatives
            .iter()
            .any(|relative| std::fs::metadata(self.path(relative)).is_ok_and(|m| m.is_file()))
    }
}

/// `KEY=value` from a logind file.
#[cfg(target_os = "linux")]
fn field(text: &str, key: &str) -> Option<String> {
    text.lines()
        .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
        .map(str::to_string)
}

#[cfg(target_os = "linux")]
fn linux_report(
    sources: &Sources,
    agent_version: String,
    launcher: LauncherVersion,
) -> DisplayReport {
    DisplayReport::Linux(Box::new(LinuxDisplay {
        seat: seat_session(sources),
        cards: cards(sources),
        uinput: Uinput {
            device: sources.exists("dev/uinput"),
            module: sources.exists("sys/module/uinput"),
        },
        nvidia_modeset: match sources
            .read(&sources.path("sys/module/nvidia_drm/parameters/modeset"))
        {
            Some(value) => NvidiaModeset::Present {
                value: value.trim().to_string(),
            },
            None => NvidiaModeset::Absent,
        },
        programs: Programs {
            xdg_desktop_portal: sources.any_file(&PORTAL_PATHS),
            gstreamer: sources.any_file(&GSTREAMER_PATHS),
            pipewiresrc: sources.any_file(&PIPEWIRESRC_PATHS),
        },
        kernel: sources
            .read(&sources.path("proc/sys/kernel/osrelease"))
            .map(|text| text.trim().to_string())
            .unwrap_or_default(),
        agent_version,
        launcher_version: launcher,
        selinux: selinux(sources),
    }))
}

/// SELinux's mode and the contexts of the agent and of systemd: on Fedora
/// these decide whether systemd may use the agent's pty and pipes.
#[cfg(target_os = "linux")]
fn selinux(sources: &Sources) -> SeLinux {
    let Some(enforce) = sources.read(&sources.path("sys/fs/selinux/enforce")) else {
        return SeLinux::Absent;
    };
    let context = |relative: &str| {
        sources
            .read(&sources.path(relative))
            .map(|text| text.trim_end_matches(['\0', '\n']).to_string())
            .unwrap_or_default()
    };
    SeLinux::Present {
        enforcing: enforce.trim() == "1",
        agent_context: context("proc/self/attr/current"),
        init_context: context("proc/1/attr/current"),
    }
}

#[cfg(target_os = "linux")]
fn seat_session(sources: &Sources) -> SeatSession {
    let Some(seat) = sources.read(&sources.path("run/systemd/seats/seat0")) else {
        return SeatSession::None;
    };
    let Some(id) = field(&seat, "ACTIVE").filter(|id| {
        !id.is_empty()
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    }) else {
        return SeatSession::None;
    };
    let Some(session) = sources.read(&sources.path(&format!("run/systemd/sessions/{id}"))) else {
        return SeatSession::None;
    };
    let leader_desktop = field(&session, "LEADER")
        .filter(|pid| !pid.is_empty() && pid.bytes().all(|byte| byte.is_ascii_digit()))
        .and_then(|pid| sources.read(&sources.path(&format!("proc/{pid}/environ"))))
        .and_then(|environ| {
            environ
                .split('\0')
                .find_map(|entry| entry.strip_prefix("XDG_CURRENT_DESKTOP="))
                .map(str::to_string)
        });
    SeatSession::Active {
        session_type: field(&session, "TYPE").unwrap_or_default(),
        class: field(&session, "CLASS").unwrap_or_default(),
        desktop: leader_desktop
            .or_else(|| field(&session, "DESKTOP"))
            .unwrap_or_default(),
        state: field(&session, "STATE").unwrap_or_default(),
        locked_hint: match field(&session, "LOCKED_HINT").as_deref() {
            Some("1" | "yes" | "true") => LockedHint::Known { locked: true },
            Some("0" | "no" | "false") => LockedHint::Known { locked: false },
            _ => LockedHint::Unknown,
        },
    }
}

/// `card0` → 0; connectors (`card0-HDMI-A-1`) and render nodes are not cards.
#[cfg(target_os = "linux")]
fn card_number(name: &str) -> Option<u32> {
    name.strip_prefix("card")?.parse().ok()
}

#[cfg(target_os = "linux")]
fn cards(sources: &Sources) -> Vec<DrmCard> {
    let drm = sources.path("sys/class/drm");
    let Ok(entries) = std::fs::read_dir(&drm) else {
        return Vec::new();
    };
    let names: Vec<String> = entries
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    let mut cards: Vec<(u32, DrmCard)> = names
        .iter()
        .filter_map(|name| Some((card_number(name)?, name)))
        .map(|(number, name)| {
            let driver = std::fs::read_link(drm.join(name).join("device/driver"))
                .ok()
                .and_then(|target| target.file_name().map(|n| n.to_string_lossy().into_owned()))
                .unwrap_or_default();
            let prefix = format!("{name}-");
            let mut outputs: Vec<&String> = names
                .iter()
                .filter(|other| other.starts_with(&prefix))
                .collect();
            outputs.sort();
            let connectors = outputs
                .iter()
                .filter_map(|output| {
                    let status = sources.read(&drm.join(output).join("status"))?;
                    if status.trim() != "connected" {
                        return None;
                    }
                    let modes = sources
                        .read(&drm.join(output).join("modes"))
                        .map(|text| {
                            text.lines()
                                .map(str::trim)
                                .filter(|mode| !mode.is_empty())
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(DrmConnector {
                        name: output[prefix.len()..].to_string(),
                        modes,
                    })
                })
                .collect();
            (
                number,
                DrmCard {
                    name: name.clone(),
                    driver,
                    kms: !outputs.is_empty(),
                    connectors,
                },
            )
        })
        .collect();
    cards.sort_by_key(|(number, _)| *number);
    cards.into_iter().map(|(_, card)| card).collect()
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::fs;

    fn write(root: &Path, relative: &str, text: &str) {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn report_from_fixture_tree() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        write(
            root,
            "run/systemd/seats/seat0",
            "IS_SEAT0=1\nACTIVE=c2\nACTIVE_UID=1000\n",
        );
        write(
            root,
            "run/systemd/sessions/c2",
            "UID=1000\nUSER=kim\nACTIVE=1\nSTATE=active\nTYPE=wayland\nCLASS=user\nSEAT=seat0\nDESKTOP=gnome\nLEADER=4242\n",
        );
        write(
            root,
            "proc/4242/environ",
            "HOME=/home/kim\0XDG_CURRENT_DESKTOP=GNOME\0",
        );
        // card1 (Intel) drives the laptop panel; card0 (NVIDIA) has nothing connected.
        write(root, "sys/class/drm/card1-eDP-1/status", "connected\n");
        write(
            root,
            "sys/class/drm/card1-eDP-1/modes",
            "1920x1080\n1280x720\n",
        );
        write(
            root,
            "sys/class/drm/card1-HDMI-A-1/status",
            "disconnected\n",
        );
        write(root, "sys/class/drm/card0-DP-1/status", "disconnected\n");
        write(root, "sys/class/drm/renderD128/dev", "226:128\n");
        write(root, "sys/bus/pci/drivers/i915/bind", "");
        write(root, "sys/bus/pci/drivers/nvidia/bind", "");
        for (card, driver) in [("card0", "nvidia"), ("card1", "i915")] {
            fs::create_dir_all(root.join(format!("sys/class/drm/{card}/device"))).unwrap();
            std::os::unix::fs::symlink(
                root.join(format!("sys/bus/pci/drivers/{driver}")),
                root.join(format!("sys/class/drm/{card}/device/driver")),
            )
            .unwrap();
        }
        write(root, "sys/module/uinput/refcnt", "0\n");
        write(root, "sys/module/nvidia_drm/parameters/modeset", "Y\n");
        write(root, "usr/libexec/xdg-desktop-portal", "");
        write(root, "usr/bin/gst-launch-1.0", "");
        write(
            root,
            "proc/sys/kernel/osrelease",
            "6.17.1-300.fc43.x86_64\n",
        );
        write(root, "sys/fs/selinux/enforce", "1");
        write(
            root,
            "proc/self/attr/current",
            "system_u:system_r:unconfined_service_t:s0\0",
        );
        write(root, "proc/1/attr/current", "system_u:system_r:init_t:s0\0");
        // /dev/uinput is a named pipe here: it must be seen without being opened.
        fs::create_dir_all(root.join("dev")).unwrap();
        let fifo = std::ffi::CString::new(root.join("dev/uinput").to_str().unwrap()).unwrap();
        // SAFETY: a valid, NUL-terminated path; mkfifo only creates the node.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);

        let sources = Sources {
            root: root.to_path_buf(),
        };
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            send.send(linux_report(
                &sources,
                "0.4.0".into(),
                LauncherVersion::Known {
                    version: "0.3.3".into(),
                },
            ))
            .unwrap()
        });
        let report = receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the report blocked on a device node");
        let DisplayReport::Linux(linux) = report else {
            panic!("expected a Linux report");
        };
        assert_eq!(
            linux.seat,
            SeatSession::Active {
                session_type: "wayland".into(),
                class: "user".into(),
                desktop: "GNOME".into(),
                state: "active".into(),
                locked_hint: LockedHint::Unknown,
            }
        );
        assert_eq!(
            linux.cards,
            [
                DrmCard {
                    name: "card0".into(),
                    driver: "nvidia".into(),
                    kms: true,
                    connectors: vec![],
                },
                DrmCard {
                    name: "card1".into(),
                    driver: "i915".into(),
                    kms: true,
                    connectors: vec![DrmConnector {
                        name: "eDP-1".into(),
                        modes: vec!["1920x1080".into(), "1280x720".into()],
                    }],
                },
            ]
        );
        assert_eq!(
            linux.uinput,
            Uinput {
                device: true,
                module: true
            }
        );
        assert_eq!(
            linux.nvidia_modeset,
            NvidiaModeset::Present { value: "Y".into() }
        );
        assert_eq!(
            linux.programs,
            Programs {
                xdg_desktop_portal: true,
                gstreamer: true,
                pipewiresrc: false
            }
        );
        assert_eq!(linux.kernel, "6.17.1-300.fc43.x86_64");
        assert_eq!(linux.agent_version, "0.4.0");
        assert_eq!(
            linux.selinux,
            SeLinux::Present {
                enforcing: true,
                agent_context: "system_u:system_r:unconfined_service_t:s0".into(),
                init_context: "system_u:system_r:init_t:s0".into(),
            }
        );

        // No active session, no DRM, nothing installed: reported as such.
        let empty = tempfile::tempdir().unwrap();
        let DisplayReport::Linux(bare) = linux_report(
            &Sources {
                root: empty.path().to_path_buf(),
            },
            "0.4.0".into(),
            LauncherVersion::None,
        ) else {
            panic!("expected a Linux report");
        };
        assert_eq!(bare.seat, SeatSession::None);
        assert!(bare.cards.is_empty());
        assert_eq!(bare.nvidia_modeset, NvidiaModeset::Absent);
        assert_eq!(bare.kernel, "");
        assert_eq!(bare.selinux, SeLinux::Absent);
    }
}
