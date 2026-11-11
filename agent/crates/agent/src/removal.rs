//! Removing BMuster at the machine (SPEC-LOCAL-PAGE-TRANSPARENCY): the
//! one-line command the local page shows anyone at the computer, and the
//! best-effort report `uninstall --purge` sends the server first, so its
//! Activity shows that a local administrator removed it.

use crate::relocate;
use crate::worker;
use bmuster_protocol::LeaveReason;
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

/// How long `uninstall --purge` waits for the server before removing BMuster
/// anyway: an unreachable server must never keep it on the machine.
pub const REPORT_LIMIT: Duration = Duration::from_secs(5);

/// The operating systems the agent installs on, for the remove command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum System {
    Linux,
    Windows,
}

impl System {
    pub fn this() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else {
            Self::Linux
        }
    }
}

/// Where to run the remove command, and the command. The console shows the
/// same commands (`src/lib/domain/machines/agent-commands.ts`, `purge`); a
/// test keeps the two the same.
pub struct RemoveCommand {
    pub shell: &'static str,
    pub command: &'static str,
}

/// Runs the current version (`paths::CURRENT_PROGRAM`), which reports the
/// removal; the rescue copy at `/opt/bmuster/bmuster-agent` may be older.
const LINUX_PURGE: &str = "sudo /opt/bmuster/versions/current/bmuster-agent uninstall --purge";
/// The service's program folder (`service_windows::install_dir`).
const WINDOWS_PURGE: &str = r#"& "$env:ProgramFiles\BMuster\bmuster-agent.exe" uninstall --purge"#;

pub fn remove_command(system: System) -> RemoveCommand {
    match system {
        System::Linux => RemoveCommand {
            shell: "In a terminal",
            command: LINUX_PURGE,
        },
        System::Windows => RemoveCommand {
            shell: "In PowerShell as administrator",
            command: WINDOWS_PURGE,
        },
    }
}

/// What came of telling the server before an uninstall.
#[derive(Debug, PartialEq, Eq)]
pub enum Report {
    Told,
    /// No identity here (never enrolled, or already purged): nobody to tell.
    NotEnrolled,
    NotTold(String),
    /// The server did not answer within [`REPORT_LIMIT`].
    TimedOut,
}

/// Tells the server, signed with this machine's own key, that an
/// administrator is removing BMuster here. Best effort: it waits at most
/// `limit`, and whatever happens the uninstall goes ahead.
pub fn tell_server(data_dir: &Path, limit: Duration) -> Report {
    let session = match worker::open_session(data_dir, false) {
        Ok(session) => session,
        Err(e) => {
            log::debug!("No identity to report the uninstall with: {e:#}");
            return Report::NotEnrolled;
        }
    };
    within(limit, move || {
        relocate::leave(&session, LeaveReason::RemovedAtMachine).map_err(|e| format!("{e:#}"))
    })
}

/// Runs `send` on its own thread and waits at most `limit` for it. A send
/// still running then is left behind; the process ends soon after.
fn within(limit: Duration, send: impl FnOnce() -> Result<(), String> + Send + 'static) -> Report {
    let (done, result) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("uninstall report".into())
        .spawn(move || {
            let _ = done.send(send());
        });
    if let Err(e) = spawned {
        return Report::NotTold(format!("could not start a thread: {e}"));
    }
    match result.recv_timeout(limit) {
        Ok(Ok(())) => Report::Told,
        Ok(Err(reason)) => Report::NotTold(reason),
        Err(_) => Report::TimedOut,
    }
}

/// The log line for a report, so the administrator knows what the server
/// heard.
pub fn describe(report: &Report) -> String {
    match report {
        Report::Told => {
            "Told the server that BMuster is being removed here by a local administrator.".into()
        }
        Report::NotEnrolled => "This machine is not enrolled; no server to tell.".into(),
        Report::NotTold(reason) => format!(
            "Could not tell the server ({reason}); removing BMuster anyway. Remove the machine in the console."
        ),
        Report::TimedOut => format!(
            "The server did not answer within {} s; removing BMuster anyway. Remove the machine in the console.",
            REPORT_LIMIT.as_secs()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relocate::tests::{enrolled, fake_server, Seen};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn the_commands_are_the_ones_the_console_shows() {
        let linux = remove_command(System::Linux);
        assert_eq!(
            linux.command,
            "sudo /opt/bmuster/versions/current/bmuster-agent uninstall --purge"
        );
        #[cfg(target_os = "linux")]
        assert!(linux.command.contains(crate::paths::CURRENT_PROGRAM));
        assert_eq!(
            remove_command(System::Windows).command,
            r#"& "$env:ProgramFiles\BMuster\bmuster-agent.exe" uninstall --purge"#
        );
        // One source for both: the console's file holds the same strings
        // (TypeScript doubles the backslashes).
        let console = std::fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../src/lib/domain/machines/agent-commands.ts"),
        )
        .unwrap();
        for system in [System::Linux, System::Windows] {
            let command = remove_command(system).command.replace('\\', "\\\\");
            assert!(
                console.contains(&format!("purge: '{command}'")),
                "agent-commands.ts lacks {command}"
            );
        }
    }

    #[test]
    fn the_report_is_attempted_and_signed_with_the_new_reason() {
        let seen = Seen::default();
        let url = fake_server("server", 200, r#"{"left":true}"#, &seen);
        let (dir, _session) = enrolled(&url);
        assert_eq!(tell_server(dir.path(), REPORT_LIMIT), Report::Told);
        assert_eq!(*seen.lock().unwrap(), ["server POST /agent/v1/leave"]);
    }

    #[test]
    fn an_unreachable_server_or_no_identity_does_not_stop_the_uninstall() {
        // Nothing listens on port 9 (discard): the report fails fast.
        let (dir, _session) = enrolled("http://127.0.0.1:9");
        assert!(matches!(
            tell_server(dir.path(), REPORT_LIMIT),
            Report::NotTold(_)
        ));
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(tell_server(empty.path(), REPORT_LIMIT), Report::NotEnrolled);
    }

    #[test]
    fn a_slow_server_is_waited_for_only_up_to_the_limit() {
        let attempted = Arc::new(AtomicBool::new(false));
        let started = Instant::now();
        let report = within(Duration::from_millis(200), {
            let attempted = Arc::clone(&attempted);
            move || {
                attempted.store(true, Ordering::SeqCst);
                std::thread::sleep(Duration::from_secs(5));
                Ok(())
            }
        });
        assert_eq!(report, Report::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert!(attempted.load(Ordering::SeqCst));
    }
}
