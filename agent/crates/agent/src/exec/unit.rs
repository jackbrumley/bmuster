//! Sessions as transient systemd services (SPEC-SESSION-UNITS).
//!
//! `systemd-run` asks the service manager to start the session's program as
//! `bmuster-<kind>-<session id>.service`. The manager (PID 1) starts it, so
//! it runs outside the agent's sandbox, with no hardening on purpose: an
//! admin's terminal is full root. `--scope` would not do: a scope's process
//! is forked by the caller and keeps the caller's mount namespace.
//!
//! - `--wait` keeps `systemd-run` running until the service ends and makes
//!   its exit code the service's, so the agent waits for `systemd-run` as it
//!   would for the program itself.
//! - `--collect` unloads the unit when it ends, even when it failed.
//! - `--service-type=exec` makes a program that cannot start an error of
//!   `systemd-run`, not a service that failed later.
//! - Stopping the unit ends every process in its control group: SIGHUP
//!   first (what closing a terminal sends), SIGKILL two seconds later.
//!
//! systemd expands `$NAME` and `${NAME}` in a service's command line, so
//! every `$` in the program's arguments is doubled to reach it unchanged.

use super::placement::Kind;
use super::spawn::Launch;
use anyhow::{bail, Result};
use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::{OsStrExt as _, OsStringExt as _};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Which systemd manager starts the session's service.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Manager {
    /// The system manager (the installed agent runs as root).
    System,
    /// DEVELOPMENT ONLY: the calling user's manager (`--user`).
    #[cfg(debug_assertions)]
    User,
}

impl Manager {
    fn flag(self) -> Option<&'static str> {
        match self {
            Manager::System => None,
            #[cfg(debug_assertions)]
            Manager::User => Some("--user"),
        }
    }
}

/// How the service's standard streams are connected.
#[derive(Debug, Clone, Copy)]
pub enum Io<'a> {
    /// The session's pseudo-terminal: systemd opens it as the service's
    /// standard streams and controlling terminal, so resizing it reaches the
    /// shell directly.
    Terminal { tty: &'a Path },
    /// `systemd-run`'s own stdin, stdout and stderr are handed to the
    /// service (`--pipe`), so the two output streams stay apart. A time
    /// limit also stops the unit if the agent is gone.
    Pipe { runtime_max: Option<Duration> },
    /// No streams (systemd's default, `/dev/null`): the self-check's
    /// `systemd-run` unit, which tests the unit itself without a pty or pipe.
    Detached,
}

/// One session's transient service.
#[derive(Debug)]
pub struct TransientUnit {
    name: String,
    manager: Manager,
    stopped: AtomicBool,
}

/// How long the service's processes get after SIGHUP before SIGKILL.
const STOP_GRACE_SECONDS: u32 = 2;
/// Extra time on a command's own limit before systemd stops it: the agent's
/// timer ends it first and reports the time-out.
const RUNTIME_SLACK: Duration = Duration::from_secs(10);

fn prefix(kind: Kind) -> &'static str {
    match kind {
        Kind::Terminal => "bmuster-terminal-",
        Kind::Exec => "bmuster-exec-",
        Kind::Files => "bmuster-files-",
    }
}

/// A command-line argument for systemd: `$` doubled.
fn escaped(argument: &OsStr) -> OsString {
    let mut bytes = Vec::with_capacity(argument.len());
    for &byte in argument.as_bytes() {
        if byte == b'$' {
            bytes.push(b'$');
        }
        bytes.push(byte);
    }
    OsString::from_vec(bytes)
}

fn joined(parts: &[&OsStr]) -> OsString {
    let mut text = OsString::new();
    for part in parts {
        text.push(part);
    }
    text
}

impl TransientUnit {
    /// The unit for session `session_id`. Session ids are the server's
    /// UUIDs; anything that could not be part of a unit name is refused.
    pub fn new(manager: Manager, kind: Kind, session_id: &str) -> Result<Self> {
        let fits = !session_id.is_empty()
            && session_id.len() <= 64
            && session_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
        if !fits {
            bail!("the session id {session_id:?} cannot name a systemd unit");
        }
        Ok(Self {
            name: format!("{}{session_id}.service", prefix(kind)),
            manager,
            stopped: AtomicBool::new(false),
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// `systemd-run`'s arguments for running `launch` as this unit.
    pub fn arguments(&self, io: Io<'_>, launch: &Launch) -> Vec<OsString> {
        let mut args: Vec<OsString> = Vec::new();
        if let Some(flag) = self.manager.flag() {
            args.push(flag.into());
        }
        args.extend(["--quiet", "--wait", "--collect", "--service-type=exec"].map(OsString::from));
        args.push(format!("--unit={}", self.name).into());
        let mut property = |value: OsString| {
            args.push("-p".into());
            args.push(value);
        };
        property("KillMode=control-group".into());
        property("KillSignal=SIGHUP".into());
        property(format!("TimeoutStopSec={STOP_GRACE_SECONDS}").into());
        // Files an admin makes are readable by others, as from a login shell
        // (the agent's own unit uses 0077 for its data folder).
        property("UMask=0022".into());
        property(joined(&[
            OsStr::new("WorkingDirectory="),
            launch.cwd.as_os_str(),
        ]));
        match io {
            Io::Terminal { tty } => {
                property(joined(&[OsStr::new("TTYPath="), tty.as_os_str()]));
                property("StandardInput=tty".into());
                property("StandardOutput=tty".into());
                property("StandardError=tty".into());
            }
            Io::Pipe { runtime_max } => {
                args.push("--pipe".into());
                if let Some(limit) = runtime_max {
                    args.push("-p".into());
                    args.push(
                        format!("RuntimeMaxSec={}", (limit + RUNTIME_SLACK).as_secs()).into(),
                    );
                }
            }
            Io::Detached => {}
        }
        for (name, value) in &launch.env {
            args.push(joined(&[
                OsStr::new("--setenv="),
                name.as_os_str(),
                OsStr::new("="),
                value.as_os_str(),
            ]));
        }
        args.push("--".into());
        args.push(escaped(launch.program.path.as_os_str()));
        // systemd cannot set argv[0]; a login shell (`-bash`) asks with -l.
        if launch.program.arg0.as_bytes().starts_with(b"-") {
            args.push("-l".into());
        }
        args.extend(launch.program.args.iter().map(|arg| escaped(arg)));
        args
    }

    /// A `systemd-run` command that runs `launch` as this unit. It keeps the
    /// agent's environment (the user manager is found through it); the
    /// service gets only `launch.env`.
    pub fn command(&self, io: Io<'_>, launch: &Launch) -> Command {
        let mut command = Command::new("systemd-run");
        command.args(self.arguments(io, launch)).current_dir("/");
        command
    }

    /// Stops the unit, ending every process in it. Only the first call
    /// does anything; a unit that already ended is not an error.
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        systemctl_stop(self.manager, &[self.name.as_str()]);
    }
}

fn systemctl_stop(manager: Manager, units: &[&str]) {
    let mut command = Command::new("systemctl");
    if let Some(flag) = manager.flag() {
        command.arg(flag);
    }
    let status = command
        .arg("stop")
        .args(units)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    if let Err(e) = status {
        log::warn!("Could not run systemctl to stop {units:?}: {e}");
    }
}

/// Stops every session unit (an earlier run's, left by a crash).
pub fn sweep(manager: Manager) {
    let patterns =
        [Kind::Terminal, Kind::Exec, Kind::Files].map(|kind| format!("{}*", prefix(kind)));
    let patterns: Vec<&str> = patterns.iter().map(String::as_str).collect();
    systemctl_stop(manager, &patterns);
}

#[cfg(test)]
mod tests {
    use super::super::spawn::Program;
    use super::*;
    use std::path::PathBuf;

    fn launch(arg0: &str, args: &[&str]) -> Launch {
        Launch {
            program: Program {
                path: PathBuf::from("/bin/bash"),
                arg0: arg0.into(),
                args: args.iter().map(OsString::from).collect(),
            },
            env: vec![
                ("HOME".into(), "/root".into()),
                ("BMUSTER_USER".into(), "Jack B".into()),
            ],
            cwd: PathBuf::from("/root"),
        }
    }

    fn strings(args: &[OsString]) -> Vec<String> {
        args.iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    const ID: &str = "0b0e8c1e-7f43-4b8e-9d1c-5a2f3e4d5c6b";

    #[test]
    fn a_terminal_is_a_login_shell_on_its_own_terminal() {
        let unit = TransientUnit::new(Manager::System, Kind::Terminal, ID).unwrap();
        let args = strings(&unit.arguments(
            Io::Terminal {
                tty: Path::new("/dev/pts/7"),
            },
            &launch("-bash", &[]),
        ));
        assert_eq!(
            args,
            [
                "--quiet",
                "--wait",
                "--collect",
                "--service-type=exec",
                "--unit=bmuster-terminal-0b0e8c1e-7f43-4b8e-9d1c-5a2f3e4d5c6b.service",
                "-p",
                "KillMode=control-group",
                "-p",
                "KillSignal=SIGHUP",
                "-p",
                "TimeoutStopSec=2",
                "-p",
                "UMask=0022",
                "-p",
                "WorkingDirectory=/root",
                "-p",
                "TTYPath=/dev/pts/7",
                "-p",
                "StandardInput=tty",
                "-p",
                "StandardOutput=tty",
                "-p",
                "StandardError=tty",
                "--setenv=HOME=/root",
                "--setenv=BMUSTER_USER=Jack B",
                "--",
                "/bin/bash",
                "-l",
            ]
        );
    }

    #[test]
    fn a_command_pipes_its_streams_and_keeps_its_dollars() {
        let unit = TransientUnit::new(Manager::System, Kind::Exec, ID).unwrap();
        let args = strings(&unit.arguments(
            Io::Pipe {
                runtime_max: Some(Duration::from_secs(60)),
            },
            &launch("/bin/bash", &["-lc", "X=1; echo $X ${HOME} $$ %h"]),
        ));
        let pipe = args.iter().position(|arg| arg == "--pipe").unwrap();
        assert_eq!(args[pipe + 1..pipe + 3], ["-p", "RuntimeMaxSec=70"]);
        assert!(args.contains(&format!("--unit=bmuster-exec-{ID}.service")));
        assert!(!args.iter().any(|arg| arg.starts_with("TTYPath=")));
        let program = args.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(
            args[program + 1..],
            ["/bin/bash", "-lc", "X=1; echo $$X $${HOME} $$$$ %h"]
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn the_development_user_manager_is_asked_with_user() {
        let unit = TransientUnit::new(Manager::User, Kind::Files, ID).unwrap();
        let args = unit.arguments(Io::Pipe { runtime_max: None }, &launch("x", &[]));
        assert_eq!(args[0], "--user");
        assert!(!strings(&args)
            .iter()
            .any(|arg| arg.starts_with("RuntimeMaxSec=")));
    }

    #[test]
    fn only_plain_session_ids_name_units() {
        for bad in ["", "a b", "../x", "a.service", "x@y", &"a".repeat(65)] {
            assert!(
                TransientUnit::new(Manager::System, Kind::Exec, bad).is_err(),
                "{bad:?}"
            );
        }
    }

    /// Runs against the developer's own systemd user manager:
    /// `cargo test -- --ignored`.
    #[cfg(debug_assertions)]
    mod user_manager {
        use super::super::super::pipe::{self, Limits, Stream};
        use super::super::super::placement::Placement;
        use super::super::super::spawn::{agent_account, command_line, environment};
        use super::*;
        use bmuster_protocol::session::Shell;

        fn session_id() -> String {
            let mut bytes = [0u8; 8];
            getrandom::getrandom(&mut bytes).unwrap();
            format!("test-{}", hex::encode(bytes))
        }

        fn unit_is_gone(name: &str) -> bool {
            let listed = Command::new("systemctl")
                .args(["--user", "list-units", "--all", "--no-legend", name])
                .output()
                .unwrap();
            listed.stdout.is_empty()
        }

        fn exec(command: &str, limits: Limits) -> (pipe::Outcome, String, String, String) {
            let id = session_id();
            let unit = TransientUnit::new(Manager::User, Kind::Exec, &id).unwrap();
            let name = unit.name().to_string();
            let program = command_line(Shell::Sh, command).unwrap();
            let account = agent_account();
            let env = environment(&account, &program, "tester", false);
            let launch = Launch {
                program,
                env,
                cwd: account.home,
            };
            let (mut out, mut err) = (Vec::new(), Vec::new());
            let outcome = pipe::run(
                &launch,
                &Placement::Unit(unit),
                limits,
                &AtomicBool::new(false),
                |stream, bytes| match stream {
                    Stream::Stdout => out.extend_from_slice(bytes),
                    Stream::Stderr => err.extend_from_slice(bytes),
                },
            )
            .unwrap();
            let text = |bytes: Vec<u8>| String::from_utf8(bytes).unwrap();
            (outcome, text(out), text(err), name)
        }

        #[test]
        #[ignore = "needs a systemd user manager"]
        fn a_command_runs_in_its_own_unit_with_split_streams_and_its_exit_code() {
            let limits = Limits {
                timeout: Duration::from_secs(20),
                max_output_bytes: 1024 * 1024,
            };
            let (outcome, out, err, name) = exec(
                "X=1; echo out $BMUSTER_USER $X ${X}; echo err >&2; cat /proc/self/cgroup; umask; exit 3",
                limits,
            );
            assert_eq!(outcome.exit_code, 3, "{out} {err}");
            assert!(!outcome.timed_out);
            // The shell, not systemd, expanded $X.
            assert!(out.starts_with("out tester 1 1\n"), "{out}");
            assert!(out.contains(&format!("/{name}\n")), "{out}");
            assert!(out.ends_with("0022\n"), "{out}");
            assert_eq!(err, "err\n");
            assert!(unit_is_gone(&name));
        }

        #[test]
        #[ignore = "needs a systemd user manager"]
        fn a_command_past_its_time_limit_is_stopped_with_its_unit() {
            let limits = Limits {
                timeout: Duration::from_millis(1500),
                max_output_bytes: 1024,
            };
            let (outcome, out, _, name) = exec("(sleep 60 &); echo started; sleep 60", limits);
            assert_eq!(out, "started\n");
            assert!(outcome.timed_out);
            assert_eq!(outcome.exit_code, -1);
            assert!(outcome.duration < Duration::from_secs(10));
            assert!(
                unit_is_gone(&name),
                "the unit and its background sleep are gone"
            );
        }
    }
}
