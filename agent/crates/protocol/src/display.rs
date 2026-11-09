//! The machine's display report (SPEC-AGENT-LOGS 3): what a remote desktop
//! depends on, sent inside the hashed inventory so it travels only when it
//! changes. Values the system does not give are `unknown` or empty, never
//! invented.

use crate::SignedInUser;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum DisplayReport {
    Linux(Box<LinuxDisplay>),
    /// The console session's user, as the inventory's signed-in user reads it.
    Windows {
        console: SignedInUser,
    },
    /// No display report on this operating system yet.
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinuxDisplay {
    /// seat0's active session, from logind's files.
    pub seat: SeatSession,
    /// Every `/sys/class/drm/card<N>`.
    pub cards: Vec<DrmCard>,
    pub uinput: Uinput,
    /// `/sys/module/nvidia_drm/parameters/modeset`, when the module is loaded.
    pub nvidia_modeset: NvidiaModeset,
    /// File checks only: nothing is run.
    pub programs: Programs,
    /// `/proc/sys/kernel/osrelease`.
    pub kernel: String,
    pub agent_version: String,
    pub launcher_version: LauncherVersion,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SeatSession {
    None,
    #[serde(rename_all = "camelCase")]
    Active {
        /// `x11`, `wayland`, `tty`, … as logind says.
        session_type: String,
        /// `user`, `greeter`, `lock-screen`, …
        class: String,
        /// `XDG_CURRENT_DESKTOP` of the session leader, else logind's
        /// `DESKTOP`; empty when neither says.
        desktop: String,
        state: String,
        locked_hint: LockedHint,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LockedHint {
    Unknown,
    Known { locked: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrmCard {
    /// `card0`.
    pub name: String,
    /// The kernel driver, e.g. `i915`, `amdgpu`, `nvidia`; empty when unknown.
    pub driver: String,
    /// True when the card has display connectors (kernel mode setting).
    pub kms: bool,
    /// Connected connectors only.
    pub connectors: Vec<DrmConnector>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrmConnector {
    /// `HDMI-A-1`, `eDP-1`, …
    pub name: String,
    /// `1920x1080`, … as the kernel lists them.
    pub modes: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Uinput {
    /// `/dev/uinput` exists (it is never opened).
    pub device: bool,
    /// `/sys/module/uinput` exists: loaded or built in.
    pub module: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum NvidiaModeset {
    Absent,
    Present { value: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Programs {
    pub xdg_desktop_portal: bool,
    pub gstreamer: bool,
    pub pipewiresrc: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LauncherVersion {
    /// Run without the launcher (development, or an agent from before it).
    None,
    Known {
        version: String,
    },
}
