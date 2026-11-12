//! Sessions as transient systemd services (SPEC-SESSION-UNITS).
//!
//! `systemd-run` asks the service manager to start the session's program as
//! `bmuster-<kind>-<session id>.service`. The manager (PID 1) starts it, so
//! it runs outside the agent's sandbox, with no hardening on purpose: an
//! admin's terminal is full root. `--scope` would not do: a scope's process
//! is forked by the caller and keeps the caller's mount namespace.
//!
//! Nothing of the agent's passes through systemd (Version 2): the unit's
//! standard input is `/dev/null` and its output goes to the journal. The
//! program it runs is a BMuster host (`pty-host`, `stdio-host`) that
//! connects back to the agent over a per-session socket ([`super::connect`]).
//!
//! - `--wait` keeps `systemd-run` running until the service ends, so the
//!   agent can tell when a unit ended before it connected.
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
use anyhow::{bail, Context as _, Result};
use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::{OsStrExt as _, OsStringExt as _};
use std::path::PathBuf;
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

/// One session's transient service.
#[derive(Debug)]
pub struct TransientUnit {
    name: String,
    kind: Kind,
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
        Kind::Storage => "bmuster-storage-",
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
            kind,
            manager,
            stopped: AtomicBool::new(false),
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn manager(&self) -> Manager {
        self.manager
    }

    /// `systemd-run`'s arguments for running `launch` as this unit. A
    /// `runtime_max` (a command's own limit) also stops the unit, with some
    /// slack, if the agent is gone.
    pub fn arguments(&self, runtime_max: Option<Duration>, launch: &Launch) -> Vec<OsString> {
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
        match self.kind {
            // Files an admin makes are readable by others, as from a login
            // shell (the agent's own unit uses 0077 for its data folder).
            Kind::Terminal | Kind::Exec | Kind::Files => property("UMask=0022".into()),
            // The storage scan reads the drives and writes only its own
            // owner-only files; it never talks to anything (SPEC-STORAGE 10).
            Kind::Storage => {
                property("UMask=0077".into());
                property("PrivateNetwork=yes".into());
                property("Nice=19".into());
                property("IOSchedulingClass=idle".into());
            }
        }
        property(joined(&[
            OsStr::new("WorkingDirectory="),
            launch.cwd.as_os_str(),
        ]));
        // Nothing of the agent's: no terminal, pipe or descriptor.
        property("StandardInput=null".into());
        property("StandardOutput=journal".into());
        property("StandardError=journal".into());
        if let Some(limit) = runtime_max {
            property(format!("RuntimeMaxSec={}", (limit + RUNTIME_SLACK).as_secs()).into());
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
        args.extend(launch.program.args.iter().map(|arg| escaped(arg)));
        args
    }

    /// A `systemd-run` command that runs `launch` as this unit. It keeps the
    /// agent's environment (the user manager is found through it); the
    /// service gets only `launch.env`.
    pub fn command(&self, runtime_max: Option<Duration>, launch: &Launch) -> Command {
        let mut command = Command::new("systemd-run");
        command
            .args(self.arguments(runtime_max, launch))
            .current_dir("/");
        command
    }

    /// Stops the unit, ending every process in it. Only the first call
    /// does anything; a unit that already ended is not an error.
    pub fn stop(&self) {
        if self.stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        stop_units(self.manager, &[self.name.as_str()]);
    }
}

/// The program a unit of `manager` runs as its host (SPEC-SESSION-UNITS,
/// Version 3): for the system manager the current version under /opt,
/// never this process's own path, because systemd may not run a program
/// from /var/lib. The development user manager runs this build (in tests,
/// the built agent beside the test binary: only ignored tests start units).
pub fn program(manager: Manager) -> Result<PathBuf> {
    match manager {
        Manager::System => Ok(PathBuf::from(crate::paths::CURRENT_PROGRAM)),
        #[cfg(debug_assertions)]
        Manager::User => {
            let program = std::env::current_exe().context("could not find this program's path")?;
            #[cfg(test)]
            let program = program
                .parent()
                .and_then(std::path::Path::parent)
                .map(|folder| folder.join("bmuster-agent"))
                .context("the test binary is not in target/<profile>/deps")?;
            Ok(program)
        }
    }
}

/// `systemctl stop` for `units` of `manager`; failures are logged.
pub fn stop_units(manager: Manager, units: &[&str]) {
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
    let patterns = [Kind::Terminal, Kind::Exec, Kind::Files, Kind::Storage]
        .map(|kind| format!("{}*", prefix(kind)));
    let patterns: Vec<&str> = patterns.iter().map(String::as_str).collect();
    stop_units(manager, &patterns);
}

#[cfg(test)]
mod tests {
    use super::super::host::{hosted, HostProgram};
    use super::super::spawn::Program;
    use super::*;
    use std::path::{Path, PathBuf};

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
    const SOCKET: &str = "/run/bmuster/connect/00112233445566778899aabbccddeeff.sock";

    #[test]
    fn a_terminal_is_a_login_shell_under_pty_host() {
        let unit = TransientUnit::new(Manager::System, Kind::Terminal, ID).unwrap();
        let hosted = hosted(
            HostProgram::Pty,
            Path::new("/opt/bmuster-agent"),
            Path::new(SOCKET),
            &launch("-bash", &[]),
        );
        let args = strings(&unit.arguments(None, &hosted));
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
                "StandardInput=null",
                "-p",
                "StandardOutput=journal",
                "-p",
                "StandardError=journal",
                "--setenv=HOME=/root",
                "--setenv=BMUSTER_USER=Jack B",
                "--",
                "/opt/bmuster-agent",
                "pty-host",
                SOCKET,
                "--",
                "/bin/bash",
                "-l",
            ]
        );
    }

    #[test]
    fn a_command_runs_under_stdio_host_and_keeps_its_dollars() {
        let unit = TransientUnit::new(Manager::System, Kind::Exec, ID).unwrap();
        let hosted = hosted(
            HostProgram::Stdio,
            Path::new("/opt/bmuster-agent"),
            Path::new(SOCKET),
            &launch("/bin/bash", &["-lc", "X=1; echo $X ${HOME} $$ %h"]),
        );
        let args = strings(&unit.arguments(Some(Duration::from_secs(60)), &hosted));
        assert!(args.contains(&"RuntimeMaxSec=70".to_string()));
        assert!(args.contains(&format!("--unit=bmuster-exec-{ID}.service")));
        let program = args.iter().position(|arg| arg == "--").unwrap();
        assert_eq!(
            args[program + 1..],
            [
                "/opt/bmuster-agent",
                "stdio-host",
                SOCKET,
                "--",
                "/bin/bash",
                "-lc",
                "X=1; echo $$X $${HOME} $$$$ %h"
            ]
        );
    }

    #[test]
    fn s11_the_storage_scan_runs_without_network_at_the_lowest_priority() {
        let unit = TransientUnit::new(Manager::System, Kind::Storage, "scan").unwrap();
        assert_eq!(unit.name(), "bmuster-storage-scan.service");
        let args = strings(&unit.arguments(None, &launch("/opt/bmuster-agent", &["storage-scan"])));
        for property in [
            "PrivateNetwork=yes",
            "UMask=0077",
            "Nice=19",
            "IOSchedulingClass=idle",
        ] {
            assert!(args.contains(&property.to_string()), "{property}");
        }
        assert!(!args.contains(&"UMask=0022".to_string()));
        let session = TransientUnit::new(Manager::System, Kind::Files, ID).unwrap();
        let args = strings(&session.arguments(None, &launch("/bin/bash", &[])));
        assert!(!args.contains(&"PrivateNetwork=yes".to_string()));
    }

    #[test]
    fn s11_the_sweep_includes_a_leftover_storage_scan() {
        assert_eq!(prefix(Kind::Storage), "bmuster-storage-");
    }

    #[test]
    fn s18_the_clean_up_runs_as_its_own_unit_without_network() {
        let unit = TransientUnit::new(Manager::System, Kind::Storage, "clean").unwrap();
        assert_eq!(unit.name(), "bmuster-storage-clean.service");
        let args =
            strings(&unit.arguments(None, &launch("/opt/bmuster-agent", &["storage-clean"])));
        assert!(args.contains(&"PrivateNetwork=yes".to_string()));
    }

    /// CB3: no unit property passes a pty path or an agent descriptor.
    #[test]
    fn units_take_no_agent_descriptors() {
        let forbidden = |arg: &String| {
            arg == "--pipe"
                || arg == "--pty"
                || arg.starts_with("--pty")
                || arg.starts_with("TTYPath=")
                || arg.ends_with("=tty")
                || arg.contains("=fd")
                || arg.starts_with("StandardInput=socket")
        };
        for (kind, host, limit) in [
            (Kind::Terminal, HostProgram::Pty, None),
            (Kind::Exec, HostProgram::Stdio, Some(Duration::from_secs(5))),
            (Kind::Files, HostProgram::Stdio, None),
        ] {
            let unit = TransientUnit::new(Manager::System, kind, ID).unwrap();
            let hosted = hosted(
                host,
                Path::new("/opt/bmuster-agent"),
                Path::new(SOCKET),
                &launch("-bash", &[]),
            );
            let args = strings(&unit.arguments(limit, &hosted));
            assert!(!args.iter().any(forbidden), "{args:?}");
            assert!(args.contains(&"StandardInput=null".to_string()));
            let program = args.iter().position(|arg| arg == "--").unwrap();
            assert_eq!(
                args[program + 3],
                SOCKET,
                "the socket is the host's one argument"
            );
        }
        let console = strings(&crate::console_helper::unit_arguments(
            "bmuster-console-1-1.service",
            Path::new("/opt/bmuster/versions/current/bmuster-agent"),
            Path::new(SOCKET),
            Path::new("/var/lib/bmuster"),
        ));
        assert!(!console.iter().any(forbidden), "{console:?}");
        let wayland = strings(&crate::wayland::capture::unit_arguments(
            "bmuster-wayland-1-1.service",
            1000,
            Path::new("/opt/bmuster/versions/current/bmuster-agent"),
            "wayland-helper",
            Path::new(SOCKET),
        ));
        assert!(!wayland.iter().any(forbidden), "{wayland:?}");
        assert_eq!(wayland.last().map(String::as_str), Some(SOCKET));
    }

    #[cfg(debug_assertions)]
    #[test]
    fn the_development_user_manager_is_asked_with_user() {
        let unit = TransientUnit::new(Manager::User, Kind::Files, ID).unwrap();
        let args = unit.arguments(None, &launch("x", &[]));
        assert_eq!(args[0], "--user");
        assert!(!strings(&args)
            .iter()
            .any(|arg| arg.starts_with("RuntimeMaxSec=")));
    }

    /// SPEC-SESSION-UNITS O2: every unit the system manager starts for the
    /// agent (terminal, command, files, console and Wayland helpers, the
    /// checks' units) runs the current version under /opt.
    #[test]
    fn programs_live_under_opt() {
        let program = program(Manager::System).unwrap();
        assert_eq!(
            program,
            Path::new("/opt/bmuster/versions/current/bmuster-agent")
        );
        assert_eq!(program, Path::new(crate::paths::CURRENT_PROGRAM));
        for (kind, host) in [
            (Kind::Terminal, HostProgram::Pty),
            (Kind::Exec, HostProgram::Stdio),
            (Kind::Files, HostProgram::Stdio),
        ] {
            let unit = TransientUnit::new(Manager::System, kind, ID).unwrap();
            let hosted = hosted(host, &program, Path::new(SOCKET), &launch("-bash", &[]));
            let args = strings(&unit.arguments(None, &hosted));
            let start = args.iter().position(|arg| arg == "--").unwrap();
            assert_eq!(args[start + 1], crate::paths::CURRENT_PROGRAM);
            assert!(!args.iter().any(|arg| arg.contains("/var/lib")), "{args:?}");
        }
        // The helpers check the same program (root's, writable by nobody else).
        let error = crate::wayland::helper_program()
            .err()
            .map(|error| format!("{error:#}"))
            .unwrap_or_default();
        assert!(
            error.is_empty() || error.contains("/opt/bmuster"),
            "{error}"
        );
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

    /// Runs against the developer's own systemd user manager, with the
    /// built agent as the host: `cargo build && cargo test -- --ignored`.
    #[cfg(debug_assertions)]
    mod user_manager {
        use super::super::super::pipe::{self, Limits, Stream};
        use super::super::super::placement::Placement;
        use super::super::super::pty::Pty;
        use super::super::super::spawn::{agent_account, command_line, environment, interactive};
        use super::super::super::PtySize;
        use super::*;
        use bmuster_protocol::session::Shell;
        use std::io::{Read as _, Write as _};

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
        #[ignore = "needs a systemd user manager and the built agent"]
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
        #[ignore = "needs a systemd user manager and the built agent"]
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

        #[test]
        #[ignore = "needs a systemd user manager and the built agent"]
        fn a_terminal_unit_has_its_own_pty_and_resizes() {
            let id = session_id();
            let unit = TransientUnit::new(Manager::User, Kind::Terminal, &id).unwrap();
            let name = unit.name().to_string();
            let program = interactive(Shell::Sh).unwrap();
            let account = agent_account();
            let env = environment(&account, &program, "tester", true);
            let launch = Launch {
                program,
                env,
                cwd: account.home,
            };
            let spawned =
                Pty::spawn(&launch, Placement::Unit(unit), PtySize::clamped(80, 24)).unwrap();
            let mut writer = spawned.writer;
            let mut reader = spawned.reader;
            let (send, seen) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut buffer = [0u8; 4096];
                while let Ok(n) = reader.read(&mut buffer) {
                    if n == 0 || send.send(buffer[..n].to_vec()).is_err() {
                        return;
                    }
                }
            });
            let mut shown = String::new();
            let wait_for = |text: &str, shown: &mut String| {
                let until = std::time::Instant::now() + Duration::from_secs(10);
                while !shown.contains(text) {
                    let left = until.saturating_duration_since(std::time::Instant::now());
                    let bytes = seen.recv_timeout(left).unwrap_or_else(|_| {
                        panic!("{text:?} never showed; the terminal showed {shown:?}")
                    });
                    shown.push_str(&String::from_utf8_lossy(&bytes));
                }
            };
            writer
                .write_all(b"cat /proc/self/cgroup; stty size; echo do''ne\n")
                .unwrap();
            wait_for("done", &mut shown);
            assert!(shown.contains(&format!("/{name}")), "{shown}");
            assert!(shown.contains("24 80"), "{shown}");
            spawned.pty.resize(PtySize::clamped(132, 43)).unwrap();
            writer.write_all(b"stty size\n").unwrap();
            wait_for("43 132", &mut shown);
            writer.write_all(b"exit 7\n").unwrap();
            let mut process = spawned.process;
            assert_eq!(process.wait().unwrap(), 7);
            spawned.pty.end();
            assert!(unit_is_gone(&name));
        }
    }
}
