//! Wayland sessions through an unprivileged portal helper.
mod capture;
pub mod helper;
mod png_stream;
pub(crate) mod wire;

use anyhow::{bail, Context as _, Result};
use bmuster_desktop::{
    capture::x11_follow::LogindWatch,
    capture::{ApprovalPhase, Capturer, DesktopState},
    follow::{Look, ScreenWatch},
    Mode, Platform,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;

fn next_id() -> u64 {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Publish only the executable, never a private key or identity file. Installed
/// agents update in a private folder that a user-session process cannot traverse.
pub fn publish_helper() -> Result<()> {
    use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
    let dir = crate::tray::status_directory()?;
    let metadata = std::fs::symlink_metadata(&dir)?;
    if !metadata.is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        bail!("Insecure helper runtime directory");
    }
    let next = dir.join(format!("helper-{}.new", std::process::id()));
    std::fs::copy(std::env::current_exe()?, &next)?;
    std::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o555))?;
    std::fs::rename(next, dir.join("bmuster-user-helper"))?;
    Ok(())
}
/// The root-owned copy of this program that helpers run (never the
/// install folder, which holds the agent's identity).
pub(crate) fn helper_program() -> Result<PathBuf> {
    let path = crate::tray::status_directory()?.join("bmuster-user-helper");
    use std::os::unix::fs::MetadataExt as _;
    let metadata = std::fs::symlink_metadata(&path)
        .context("Rerun the administrator installer to enable the Wayland helper")?;
    if !metadata.is_file() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        bail!("Insecure Wayland helper executable");
    }
    Ok(path)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UserSession {
    id: String,
    uid: u32,
    name: String,
    locked: bool,
}
fn active_session() -> Result<Option<UserSession>> {
    let result = std::process::Command::new("loginctl")
        .args(["show-seat", "seat0", "--property=ActiveSession", "--value"])
        .output()?;
    if !result.status.success() {
        bail!("Cannot query seat0");
    }
    let id = String::from_utf8(result.stdout)?.trim().to_string();
    if id.is_empty() {
        return Ok(None);
    }
    if id.len() > 128 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        bail!("Invalid logind session id");
    }
    let result = std::process::Command::new("loginctl")
        .args([
            "show-session",
            &id,
            "--property=Type",
            "--property=Class",
            "--property=User",
            "--property=Name",
            "--property=LockedHint",
            "--property=State",
        ])
        .output()?;
    if !result.status.success() {
        bail!("Cannot query active session");
    }
    parse_session(&id, &String::from_utf8(result.stdout)?)
}
fn parse_session(id: &str, text: &str) -> Result<Option<UserSession>> {
    let values: std::collections::HashMap<_, _> = text
        .lines()
        .filter_map(|line| line.split_once('='))
        .collect();
    let get = |key| values.get(key).copied().unwrap_or("");
    if get("Type") != "wayland" || get("Class") != "user" || get("State") == "closing" {
        return Ok(None);
    }
    let uid = get("User")
        .parse::<u32>()
        .context("Invalid Wayland user id")?;
    if uid == 0 {
        bail!("Wayland remote access is not supported for a root desktop");
    }
    Ok(Some(UserSession {
        id: id.into(),
        uid,
        name: get("Name").into(),
        locked: get("LockedHint") == "yes",
    }))
}

/// The screen at the machine (SPEC-CONSOLE-CAPTURE): X11 screens through
/// XShm and XTest, everything else through KMS and uinput. A signed-in
/// Wayland desktop that KMS cannot read (some NVIDIA set-ups) falls back to
/// the desktop portal, which asks the person at the machine to approve.
pub struct Watch {
    x11: LogindWatch,
    data_dir: PathBuf,
    control: bool,
    user: Option<UserSession>,
    bridge: Option<Arc<capture::Bridge>>,
    requested: bool,
    failure: Option<String>,
}
impl Watch {
    pub fn new(data_dir: &Path, mode: Mode) -> Self {
        Self {
            x11: LogindWatch::with_console(Box::new(crate::console_helper::Opener::new(data_dir))),
            data_dir: data_dir.into(),
            control: mode == Mode::Control,
            user: None,
            bridge: None,
            requested: false,
            failure: None,
        }
    }
}
impl ScreenWatch for Watch {
    fn request_approval(&mut self) -> Result<(), String> {
        if self.user.is_none() {
            return Err("No signed-in Wayland desktop is available".into());
        }
        if self.bridge.is_none() {
            self.requested = true;
            self.failure = None;
        }
        Ok(())
    }
    fn look(&mut self) -> Look {
        let look = self.x11.look();
        if self.x11.console_failure().is_none() {
            self.user = None;
            self.bridge = None;
            self.requested = false;
            self.failure = None;
            return look;
        }
        let active = match active_session() {
            Ok(active) => active,
            Err(error) => {
                self.bridge = None;
                return Look {
                    key: "wayland-query-failed".into(),
                    state: DesktopState::Unavailable {
                        reason: format!("{error:#}"),
                    },
                };
            }
        };
        let same =
            self.user.as_ref().map(|u| (&u.id, u.uid)) == active.as_ref().map(|u| (&u.id, u.uid));
        if !same {
            self.bridge = None;
            self.requested = false;
            self.failure = None;
        }
        self.user = active;
        let Some(user) = &self.user else {
            return look;
        };
        if user.locked {
            self.bridge = None;
            return Look {
                key: format!("wayland-{}-locked", user.id),
                state: DesktopState::Unavailable {
                    reason:
                        "The Wayland desktop is locked; unlock it at the machine to resume sharing"
                            .into(),
                },
            };
        }
        if self.bridge.is_none()
            && self.failure.is_none()
            && (self.requested
                || capture::token_path(&self.data_dir, user.uid, self.control).exists())
        {
            self.requested = false;
            match capture::start(user.uid, self.control, &self.data_dir) {
                Ok(bridge) => self.bridge = Some(bridge),
                Err(error) => self.failure = Some(format!("{error:#}")),
            }
        }
        let mut phase = ApprovalPhase::Needed;
        let mut message = "Allow screen sharing on this computer before connecting".to_string();
        if let Some(bridge) = &self.bridge {
            let state = bridge.state.lock().unwrap_or_else(|p| p.into_inner());
            if let Some(error) = &state.error {
                self.failure = Some(error.clone());
            } else if state.ready && state.frame.is_some() {
                return Look {
                    key: format!("wayland-{}-ready", user.id),
                    state: DesktopState::Desktop {
                        user: Some(user.name.clone()),
                    },
                };
            } else {
                phase = ApprovalPhase::Pending;
                message = "Approve sharing at the machine; waiting for the desktop portal and its first frame".into();
            }
        }
        if let Some(error) = &self.failure {
            phase = ApprovalPhase::Declined;
            message = error.clone();
            self.bridge = None;
        }
        Look {
            key: format!("wayland-{}-{phase:?}", user.id),
            state: DesktopState::Approval { phase, message },
        }
    }
    fn open(&mut self) -> Result<Platform, String> {
        let Some(bridge) = &self.bridge else {
            return self.x11.open();
        };
        let screen = capture::Screen::new(Arc::clone(bridge)).map_err(|e| format!("{e:#}"))?;
        let physical = (
            i32::try_from(screen.frame().width).map_err(|_| "Wayland frame is too wide")?,
            i32::try_from(screen.frame().height).map_err(|_| "Wayland frame is too tall")?,
        );
        let bridge = Arc::clone(bridge);
        let control = self.control;
        Ok(Platform {
            capturer: Box::new(screen),
            make_input: Box::new(move || {
                if !control {
                    return Err(bmuster_desktop::input::InputError(
                        "Watch sessions cannot control Wayland".into(),
                    ));
                }
                Ok(Box::new(capture::Input { bridge, physical }))
            }),
            notice_target: bmuster_desktop::notice::Target::Portal,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn active_session_lifecycle() {
        assert!(parse_session("1", "Type=wayland\nClass=greeter\nUser=120")
            .unwrap()
            .is_none());
        assert!(parse_session("1", "Type=x11\nClass=user\nUser=1000")
            .unwrap()
            .is_none());
        assert!(parse_session("1", "Type=wayland\nClass=user\nUser=0").is_err());
        let user = parse_session(
            "2",
            "Type=wayland\nClass=user\nUser=1000\nName=jack\nLockedHint=yes",
        )
        .unwrap()
        .unwrap();
        assert_eq!(user.uid, 1000);
        assert!(user.locked);
        assert!(
            parse_session("2", "Type=wayland\nClass=user\nUser=1000\nState=closing")
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn rotation_and_isolation() {
        let dir = tempfile::tempdir().unwrap();
        assert_ne!(
            capture::token_path(dir.path(), 1000, true),
            capture::token_path(dir.path(), 1001, true)
        );
        assert_ne!(
            capture::token_path(dir.path(), 1000, true),
            capture::token_path(dir.path(), 1000, false)
        );
    }
}
