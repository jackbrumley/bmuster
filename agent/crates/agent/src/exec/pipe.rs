//! Running one command without a terminal (the MCP `run_command` tool,
//! docs/mcp.md): no input, stdout and stderr kept apart, a time limit and an
//! output cap. Everything the command starts ends with it.

use super::placement::Placement;
use super::spawn::Launch;
use anyhow::{Context as _, Result};
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The largest time limit a ticket may ask for (docs/mcp.md; the server's default is 60 s).
pub const MAX_TIMEOUT: Duration = Duration::from_secs(600);
/// The largest output cap, both streams together (the server's default is 1 MB).
pub const MAX_OUTPUT: u64 = 16 * 1024 * 1024;

/// How long to keep reading after the command ends, for output still in the pipes.
const DRAIN: Duration = Duration::from_secs(1);
const CHUNK: usize = 8 * 1024;
const TICK: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub timeout: Duration,
    pub max_output_bytes: u64,
}

impl Limits {
    /// What a ticket asked for, held to the largest allowed.
    pub fn clamped(timeout_ms: u64, max_output_bytes: u64) -> Self {
        Self {
            timeout: Duration::from_millis(timeout_ms).min(MAX_TIMEOUT),
            max_output_bytes: max_output_bytes.min(MAX_OUTPUT),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Outcome {
    /// The exit code, 128 + the signal on Unix, or -1 when it was killed.
    pub exit_code: i32,
    pub duration: Duration,
    /// Output beyond the cap was dropped.
    pub truncated: bool,
    pub timed_out: bool,
}

enum Event {
    Output(Stream, Vec<u8>),
    Closed,
}

fn read_into(mut source: impl Read, stream: Stream, events: mpsc::Sender<Event>) {
    let mut buffer = vec![0u8; CHUNK];
    loop {
        match source.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if events
                    .send(Event::Output(stream, buffer[..n].to_vec()))
                    .is_err()
                {
                    break;
                }
            }
        }
    }
    let _ = events.send(Event::Closed);
}

/// The command as the agent's own child, with only `launch.env`.
fn in_process(launch: &Launch) -> Command {
    let mut command = Command::new(&launch.program.path);
    command
        .args(&launch.program.args)
        .current_dir(&launch.cwd)
        .env_clear()
        .envs(launch.env.iter().map(|(name, value)| (name, value)));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        command.arg0(&launch.program.arg0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;
        // CREATE_NO_WINDOW: a service has no console to show.
        command.creation_flags(0x0800_0000);
    }
    command
}

/// Runs `launch` to the end, the time limit, or `stop`, handing output to
/// `sink` as it arrives (never more than the cap in total). For a unit,
/// `systemd-run` hands its pipes to the service and exits with its code.
pub fn run(
    launch: &Launch,
    placement: &Placement,
    limits: Limits,
    stop: &AtomicBool,
    mut sink: impl FnMut(Stream, &[u8]),
) -> Result<Outcome> {
    let started = Instant::now();
    let mut command = match placement {
        Placement::InProcess => in_process(launch),
        #[cfg(target_os = "linux")]
        Placement::Unit(unit) => unit.command(
            super::unit::Io::Pipe {
                runtime_max: Some(limits.timeout),
            },
            launch,
        ),
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt as _;
        // SAFETY: setsid is async-signal-safe. The command leads its own
        // session, so everything it starts can be found and ended.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let mut child = command.spawn().with_context(|| {
        format!(
            "could not start {}",
            std::path::Path::new(command.get_program()).display()
        )
    })?;
    let tree = Tree::of(&child)?;
    let end = || {
        placement.end();
        tree.end();
    };

    let (events, inbox) = mpsc::channel();
    let mut readers = 0;
    if let Some(stdout) = child.stdout.take() {
        let events = events.clone();
        std::thread::spawn(move || read_into(stdout, Stream::Stdout, events));
        readers += 1;
    }
    if let Some(stderr) = child.stderr.take() {
        let events = events.clone();
        std::thread::spawn(move || read_into(stderr, Stream::Stderr, events));
        readers += 1;
    }
    drop(events);

    let deadline = started + limits.timeout;
    let mut delivered: u64 = 0;
    let mut truncated = false;
    let mut timed_out = false;
    let mut status = None;
    let mut drain_until: Option<Instant> = None;

    while readers > 0 {
        if status.is_none() {
            if let Some(exit) = child.try_wait().context("could not check the command")? {
                status = Some(exit);
                // Anything it left running goes too; its output so far is kept.
                end();
                drain_until = Some(Instant::now() + DRAIN);
            } else if stop.load(Ordering::SeqCst) || Instant::now() >= deadline {
                timed_out = !stop.load(Ordering::SeqCst);
                end();
                let _ = child.kill();
                status = Some(child.wait().context("could not wait for the command")?);
                drain_until = Some(Instant::now() + DRAIN);
            }
        }
        if drain_until.is_some_and(|until| Instant::now() >= until) {
            break;
        }
        match inbox.recv_timeout(TICK) {
            Ok(Event::Output(stream, bytes)) => {
                let room = limits.max_output_bytes.saturating_sub(delivered);
                let take = usize::try_from(room).unwrap_or(usize::MAX).min(bytes.len());
                if take < bytes.len() {
                    truncated = true;
                }
                if take > 0 {
                    sink(stream, &bytes[..take]);
                    delivered += take as u64;
                }
            }
            Ok(Event::Closed) => readers -= 1,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let status = match status {
        Some(status) => status,
        None => child.wait().context("could not wait for the command")?,
    };
    let exit_code = if timed_out || stop.load(Ordering::SeqCst) {
        -1
    } else {
        exit_code_of(status)
    };
    Ok(Outcome {
        exit_code,
        duration: started.elapsed(),
        truncated,
        timed_out,
    })
}

#[cfg(unix)]
fn exit_code_of(status: std::process::ExitStatus) -> i32 {
    use std::os::unix::process::ExitStatusExt as _;
    status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
        .unwrap_or(-1)
}

#[cfg(windows)]
fn exit_code_of(status: std::process::ExitStatus) -> i32 {
    status.code().unwrap_or(-1)
}

/// Everything the command started.
#[cfg(unix)]
struct Tree(libc::pid_t);

#[cfg(unix)]
impl Tree {
    fn of(child: &std::process::Child) -> Result<Self> {
        Ok(Tree(
            libc::pid_t::try_from(child.id()).context("process id out of range")?,
        ))
    }

    fn end(&self) {
        super::tree::end_session(self.0);
    }
}

/// Everything the command started: its job. The process is added just after
/// it starts (std cannot start it suspended); a command that starts another
/// process within that instant would leave that one outside the job.
#[cfg(windows)]
struct Tree(super::tree::Job);

#[cfg(windows)]
impl Tree {
    fn of(child: &std::process::Child) -> Result<Self> {
        use std::os::windows::io::AsRawHandle as _;
        let job = super::tree::Job::new()?;
        job.assign(child.as_raw_handle())?;
        Ok(Tree(job))
    }

    fn end(&self) {
        self.0.terminate();
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::spawn::{agent_account, command_line, environment};
    use super::*;
    use bmuster_protocol::session::Shell;

    fn launch(command: &str) -> Launch {
        let program = command_line(Shell::Sh, command).unwrap();
        let account = agent_account();
        let env = environment(&account, &program, "tester", false);
        Launch {
            program,
            env,
            cwd: std::env::temp_dir(),
        }
    }

    fn collect(command: &str, limits: Limits) -> (Outcome, Vec<u8>, Vec<u8>) {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let outcome = run(
            &launch(command),
            &Placement::InProcess,
            limits,
            &AtomicBool::new(false),
            |stream, bytes| match stream {
                Stream::Stdout => out.extend_from_slice(bytes),
                Stream::Stderr => err.extend_from_slice(bytes),
            },
        )
        .unwrap();
        (outcome, out, err)
    }

    const QUICK: Limits = Limits {
        timeout: Duration::from_secs(20),
        max_output_bytes: 1024 * 1024,
    };

    #[test]
    fn output_streams_stay_apart_and_the_exit_code_comes_back() {
        let (outcome, out, err) = collect("echo out; echo err >&2; exit 3", QUICK);
        assert_eq!(out, b"out\n");
        assert_eq!(err, b"err\n");
        assert_eq!(outcome.exit_code, 3);
        assert!(!outcome.timed_out && !outcome.truncated);
    }

    #[test]
    fn input_is_empty() {
        let (outcome, out, _) = collect("cat; echo done", QUICK);
        assert_eq!(out, b"done\n");
        assert_eq!(outcome.exit_code, 0);
    }

    #[test]
    fn the_environment_names_the_console_user() {
        let (_, out, _) = collect("echo $BMUSTER_USER", QUICK);
        assert_eq!(out, b"tester\n");
    }

    #[test]
    fn output_is_capped() {
        let limits = Limits {
            timeout: Duration::from_secs(20),
            max_output_bytes: 1000,
        };
        let (outcome, out, _) = collect("head -c 100000 /dev/zero", limits);
        assert_eq!(out.len(), 1000);
        assert!(outcome.truncated);
        assert_eq!(outcome.exit_code, 0);
    }

    #[test]
    fn the_time_limit_kills_the_command_and_what_it_started() {
        let marker = tempfile::tempdir().unwrap();
        let file = marker.path().join("survived");
        let limits = Limits {
            timeout: Duration::from_millis(500),
            max_output_bytes: 1024,
        };
        let command = format!(
            "(sleep 2; touch {}) & echo started; sleep 30",
            file.display()
        );
        let (outcome, out, _) = collect(&command, limits);
        assert_eq!(out, b"started\n");
        assert!(outcome.timed_out);
        assert_eq!(outcome.exit_code, -1);
        assert!(outcome.duration < Duration::from_secs(10));
        std::thread::sleep(Duration::from_secs(3));
        assert!(!file.exists(), "the background job was killed too");
    }

    #[test]
    fn limits_are_clamped() {
        let limits = Limits::clamped(u64::MAX, u64::MAX);
        assert_eq!(limits.timeout, MAX_TIMEOUT);
        assert_eq!(limits.max_output_bytes, MAX_OUTPUT);
    }
}
