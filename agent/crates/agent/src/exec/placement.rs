//! Where a session's processes run (SPEC-SESSION-UNITS).
//!
//! The installed Linux agent runs in a hardened systemd unit (read-only
//! system and home folders, a private /tmp, no new privileges). A terminal,
//! a command or a files session started inside that sandbox inherits it, so
//! an admin could not make a folder in /home or use sudo. With
//! `--sessions systemd` each such session runs as its own transient service
//! instead, started by the service manager (PID 1), outside the agent's
//! sandbox. The agent itself stays sandboxed.
//!
//! The mode is an explicit setting (`run --sessions`, or `BMUSTER_SESSIONS`
//! from the unit), never guessed: development runs, tests and machines
//! without systemd run sessions in the agent's own process, as before.

use anyhow::Result;

/// The `--sessions` setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum SessionMode {
    /// Sessions are the agent's own child processes, inside its sandbox.
    InProcess,
    /// Each session is a transient service of the system manager.
    #[cfg(target_os = "linux")]
    Systemd,
    /// DEVELOPMENT ONLY: transient services of the caller's user manager
    /// (`systemd-run --user`), to try the systemd path without root.
    #[cfg(all(target_os = "linux", debug_assertions))]
    SystemdUser,
}

/// The kind of session a transient unit is for; it names the unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Terminal,
    Exec,
    Files,
}

/// Where one session's processes run.
#[derive(Debug)]
pub enum Placement {
    /// As children of the agent.
    InProcess,
    /// As a transient systemd service.
    #[cfg(target_os = "linux")]
    Unit(super::unit::TransientUnit),
}

impl SessionMode {
    /// One line for the log when the agent starts.
    pub fn describe(self) -> &'static str {
        match self {
            SessionMode::InProcess => {
                "Terminal, command and files sessions run inside the agent's own process."
            }
            #[cfg(target_os = "linux")]
            SessionMode::Systemd => {
                "Terminal, command and files sessions run as transient systemd services, outside the agent's sandbox."
            }
            #[cfg(all(target_os = "linux", debug_assertions))]
            SessionMode::SystemdUser => {
                "DEVELOPMENT: terminal, command and files sessions run as transient services of the user's systemd manager."
            }
        }
    }

    /// Where session `session_id` of `kind` runs.
    pub fn placement(self, kind: Kind, session_id: &str) -> Result<Placement> {
        match self {
            SessionMode::InProcess => {
                let _ = (kind, session_id);
                Ok(Placement::InProcess)
            }
            #[cfg(target_os = "linux")]
            SessionMode::Systemd => unit(super::unit::Manager::System, kind, session_id),
            #[cfg(all(target_os = "linux", debug_assertions))]
            SessionMode::SystemdUser => unit(super::unit::Manager::User, kind, session_id),
        }
    }

    /// Ends session units an earlier run of the agent left behind (it
    /// crashed or was killed while sessions were open).
    pub fn sweep(self) {
        #[cfg(target_os = "linux")]
        if let Some(manager) = self.manager() {
            super::unit::sweep(manager);
            // Sockets of units that never connected.
            match super::connect::Folder::for_manager(manager) {
                Ok(folder) => folder.sweep(),
                Err(e) => log::warn!("{e:#}"),
            }
        }
    }
}

#[cfg(target_os = "linux")]
fn unit(manager: super::unit::Manager, kind: Kind, session_id: &str) -> Result<Placement> {
    let unit = super::unit::TransientUnit::new(manager, kind, session_id)?;
    log::info!("Session {session_id} runs as {}.", unit.name());
    Ok(Placement::Unit(unit))
}

impl SessionMode {
    /// The systemd manager that starts session units, if sessions run as units.
    #[cfg(target_os = "linux")]
    pub fn manager(self) -> Option<super::unit::Manager> {
        match self {
            SessionMode::InProcess => None,
            SessionMode::Systemd => Some(super::unit::Manager::System),
            #[cfg(debug_assertions)]
            SessionMode::SystemdUser => Some(super::unit::Manager::User),
        }
    }
}

impl Placement {
    /// Where the session runs, for its timeline.
    pub fn describe(&self) -> String {
        match self {
            Placement::InProcess => "in the agent's process".into(),
            #[cfg(target_os = "linux")]
            Placement::Unit(unit) => unit.name().to_string(),
        }
    }

    /// Stops the session's unit, which ends every process in it. In-process
    /// sessions end their process tree themselves.
    pub fn end(&self) {
        match self {
            Placement::InProcess => {}
            #[cfg(target_os = "linux")]
            Placement::Unit(unit) => unit.stop(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::ValueEnum as _;

    #[test]
    fn in_process_is_the_default_and_places_nothing() {
        let mode = SessionMode::from_str("in-process", false).unwrap();
        assert_eq!(mode, SessionMode::InProcess);
        assert!(matches!(
            mode.placement(Kind::Terminal, "s-1").unwrap(),
            Placement::InProcess
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn systemd_places_each_session_in_its_own_unit() {
        let mode = SessionMode::from_str("systemd", false).unwrap();
        let Placement::Unit(unit) = mode
            .placement(Kind::Files, "0b0e8c1e-7f43-4b8e-9d1c-5a2f3e4d5c6b")
            .unwrap()
        else {
            panic!("systemd mode makes a unit");
        };
        assert_eq!(
            unit.name(),
            "bmuster-files-0b0e8c1e-7f43-4b8e-9d1c-5a2f3e4d5c6b.service"
        );
        assert!(mode.placement(Kind::Exec, "../etc").is_err());
    }

    #[test]
    fn unknown_modes_are_refused() {
        assert!(SessionMode::from_str("sandbox", false).is_err());
    }
}
