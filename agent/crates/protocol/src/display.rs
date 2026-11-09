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
        /// Build, console session, DXGI outputs and SAS policy
        /// (SPEC-DIAGNOSTICS 4); agents before 0.4.3 leave it out.
        #[serde(default)]
        system: WindowsSystem,
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
    /// SELinux mode and security contexts; older agents do not send it.
    #[serde(default)]
    pub selinux: SeLinux,
}

/// SELinux, read from `/sys/fs/selinux/enforce` and `/proc/<pid>/attr/current`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SeLinux {
    /// From an agent before 0.4.2.
    #[default]
    Unreported,
    /// No SELinux file system: not enabled.
    Absent,
    #[serde(rename_all = "camelCase")]
    Present {
        enforcing: bool,
        /// The agent's own context, e.g. `system_u:system_r:unconfined_service_t:s0`.
        agent_context: String,
        /// systemd's (PID 1) context.
        init_context: String,
    },
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

/// What a Windows desktop session depends on (SPEC-DIAGNOSTICS 4).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum WindowsSystem {
    /// From an agent before 0.4.3.
    #[default]
    Unreported,
    #[serde(rename_all = "camelCase")]
    Reported {
        /// `CurrentBuild.UBR`, e.g. `26100.2314`; empty when unknown.
        build: String,
        /// `EditionID`, e.g. `Professional`; empty when unknown.
        edition: String,
        console_session: ConsoleSession,
        secure_desktop: SecureDesktop,
        /// Every DXGI output, as the service sees them.
        outputs: Vec<DxgiOutput>,
        /// `SoftwareSASGeneration` (0 none, 1 services, 2 apps, 3 both).
        sas_policy: SasPolicy,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ConsoleSession {
    /// No session is attached to the console.
    None,
    Attached {
        id: u32,
        /// `active`, `connected`, `disconnected`, …
        state: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SecureDesktop {
    Unknown,
    Known { active: bool },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DxgiOutput {
    pub adapter: String,
    /// `\\.\DISPLAY1`, …
    pub name: String,
    pub width: u32,
    pub height: u32,
    /// Degrees: 0, 90, 180 or 270.
    pub rotation: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SasPolicy {
    /// The policy value is not set (Windows' default: none).
    NotSet,
    Set {
        value: u32,
    },
}
