//! The agent's side of a session unit's host program (SPEC-SESSION-UNITS,
//! Version 2).
//!
//! A terminal unit runs `bmuster-agent pty-host <socket> -- <shell> -l`, a
//! command or files unit `bmuster-agent stdio-host <socket> -- <program>`.
//! The host connects back over [`super::connect`] and the two sides speak
//! [`super::channel`] frames. Here the frames become what the in-process
//! sessions already use: a reader for the output, another for the error
//! output, a writer for the input, and the exit code.

use super::channel::{self, Frame};
use super::connect::{self, ConnectSocket, Folder, Peer};
use super::spawn::{Launch, Program};
use super::unit::TransientUnit;
use super::PtySize;
use anyhow::{Context as _, Result};
use std::ffi::OsString;
use std::io::{self, BufReader, PipeReader, PipeWriter, Write};
use std::os::unix::ffi::OsStrExt as _;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::Child;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// Which host program the unit runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostProgram {
    /// Makes the pty inside the unit and runs the shell on it.
    Pty,
    /// Runs the program with pipes and relays them.
    Stdio,
}

impl HostProgram {
    fn subcommand(self) -> &'static str {
        match self {
            HostProgram::Pty => "pty-host",
            HostProgram::Stdio => "stdio-host",
        }
    }
}

/// `launch` as `agent <host> <socket> -- <program> <args>`, with the same
/// environment and folder. systemd cannot set `argv[0]`, so a login shell
/// (`-bash`) asks with `-l`.
pub fn hosted(host: HostProgram, agent: &Path, socket: &Path, launch: &Launch) -> Launch {
    let mut args: Vec<OsString> = vec![
        host.subcommand().into(),
        socket.as_os_str().to_os_string(),
        "--".into(),
        launch.program.path.clone().into_os_string(),
    ];
    if launch.program.arg0.as_bytes().starts_with(b"-") {
        args.push("-l".into());
    }
    args.extend(launch.program.args.iter().cloned());
    Launch {
        program: Program {
            arg0: agent.as_os_str().to_os_string(),
            path: agent.to_path_buf(),
            args,
        },
        env: launch.env.clone(),
        cwd: launch.cwd.clone(),
    }
}

/// How the hosted program ended, as far as the agent knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExitState {
    Running,
    Code(i32),
    /// The host could not start the program.
    Failed(String),
    /// The connection closed without an exit code (the host was stopped
    /// or crashed).
    Lost,
}

impl ExitState {
    /// The exit code, or the error that stands for it.
    pub fn code(self) -> Result<Option<i32>> {
        match self {
            ExitState::Running => Ok(None),
            ExitState::Code(code) => Ok(Some(code)),
            ExitState::Failed(message) => Err(anyhow::anyhow!(message)),
            ExitState::Lost => Err(anyhow::anyhow!(
                "The session's host ended without an exit code (see the machine's journal)"
            )),
        }
    }
}

/// The hosted program's exit, filled in by the frame reader.
#[derive(Clone)]
pub struct Exit(Arc<(Mutex<ExitState>, Condvar)>);

impl Exit {
    fn new() -> Exit {
        Exit(Arc::new((Mutex::new(ExitState::Running), Condvar::new())))
    }

    fn set(&self, state: ExitState) {
        let (lock, changed) = &*self.0;
        let mut current = lock.lock().unwrap_or_else(|p| p.into_inner());
        if *current == ExitState::Running {
            *current = state;
            changed.notify_all();
        }
    }

    pub fn peek(&self) -> ExitState {
        let (lock, _) = &*self.0;
        lock.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Waits until it ended or `wait` passed.
    pub fn wait_for(&self, wait: Duration) -> ExitState {
        let until = Instant::now() + wait;
        let (lock, changed) = &*self.0;
        let mut current = lock.lock().unwrap_or_else(|p| p.into_inner());
        while *current == ExitState::Running {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            current = changed
                .wait_timeout(current, left)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        current.clone()
    }

    /// Waits until it ended.
    pub fn wait(&self) -> ExitState {
        let (lock, changed) = &*self.0;
        let mut current = lock.lock().unwrap_or_else(|p| p.into_inner());
        while *current == ExitState::Running {
            current = changed.wait(current).unwrap_or_else(|p| p.into_inner());
        }
        current.clone()
    }
}

/// Sends frames to the host. Clones share the connection.
#[derive(Clone)]
pub struct HostInput(Arc<Mutex<UnixStream>>);

impl HostInput {
    fn send(&self, frame: &Frame) -> io::Result<()> {
        let mut stream = self.0.lock().unwrap_or_else(|p| p.into_inner());
        channel::write(&mut *stream, frame)
    }

    pub fn send_bytes(&self, bytes: &[u8]) -> io::Result<()> {
        let mut stream = self.0.lock().unwrap_or_else(|p| p.into_inner());
        channel::write_split(&mut *stream, bytes, Frame::Input)
    }

    /// The program's input ends (it reads end of file).
    pub fn close_input(&self) -> io::Result<()> {
        self.send(&Frame::InputClosed)
    }

    pub fn resize(&self, size: PtySize) -> io::Result<()> {
        self.send(&Frame::Resize(size))
    }
}

/// The program's input as a writer; dropping it closes the input.
pub struct InputWriter(HostInput);

impl InputWriter {
    pub fn new(input: HostInput) -> InputWriter {
        InputWriter(input)
    }
}

impl Write for InputWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.send_bytes(bytes)?;
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for InputWriter {
    fn drop(&mut self) {
        let _ = self.0.close_input();
    }
}

/// One connection's channels, as readers, a writer and the exit.
pub struct Channels {
    pub input: HostInput,
    pub stdout: PipeReader,
    pub stderr: PipeReader,
    pub exit: Exit,
}

/// Splits a host's connection into its channels. One thread reads the
/// frames; output nobody reads any more is dropped.
pub fn channels(stream: UnixStream) -> Result<Channels> {
    let reading = stream.try_clone()?;
    let (stdout, stdout_writer) = std::io::pipe()?;
    let (stderr, stderr_writer) = std::io::pipe()?;
    let exit = Exit::new();
    let filled = exit.clone();
    std::thread::Builder::new()
        .name("host frames".into())
        .spawn(move || demultiplex(reading, stdout_writer, stderr_writer, &filled))
        .context("could not start reading the session's host")?;
    Ok(Channels {
        input: HostInput(Arc::new(Mutex::new(stream))),
        stdout,
        stderr,
        exit,
    })
}

fn demultiplex(stream: UnixStream, stdout: PipeWriter, stderr: PipeWriter, exit: &Exit) {
    let mut stream = BufReader::new(stream);
    let mut stdout = Some(stdout);
    let mut stderr = Some(stderr);
    let deliver = |pipe: &mut Option<PipeWriter>, bytes: &[u8]| {
        if let Some(writer) = pipe {
            if writer.write_all(bytes).is_err() {
                *pipe = None;
            }
        }
    };
    loop {
        match channel::read(&mut stream) {
            Ok(Some(Frame::Stdout(bytes))) => deliver(&mut stdout, &bytes),
            Ok(Some(Frame::Stderr(bytes))) => deliver(&mut stderr, &bytes),
            Ok(Some(Frame::Exit(code))) => exit.set(ExitState::Code(code)),
            Ok(Some(Frame::Failed(message))) => exit.set(ExitState::Failed(message)),
            Ok(Some(other)) => {
                log::warn!("The session's host sent an agent frame: {other:?}");
                break;
            }
            Ok(None) => break,
            Err(e) => {
                log::debug!("The session's host connection ended: {e}");
                break;
            }
        }
    }
    // The output ends before the exit is final, so readers see all of it.
    drop((stdout, stderr));
    exit.set(ExitState::Lost);
}

/// `systemd-run --wait` for a unit whose host connected, and the
/// connection. Ending it closes the connection and ends `systemd-run`.
pub struct SystemdRun {
    child: Mutex<Option<Child>>,
    stream: UnixStream,
}

impl SystemdRun {
    /// Closes the connection and ends `systemd-run`'s session. Stop the
    /// unit first ([`TransientUnit::stop`]); only the first call does
    /// anything.
    pub fn end(&self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
        let child = self.child.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(mut child) = child {
            if let Ok(pid) = libc::pid_t::try_from(child.id()) {
                super::tree::end_session(pid);
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for SystemdRun {
    fn drop(&mut self) {
        self.end();
    }
}

/// A unit whose host connected.
pub struct Started {
    pub channels: Channels,
    pub systemd_run: SystemdRun,
}

/// Starts `launch` in `unit` under `host` and waits for the host to connect
/// back. Errors say why it did not, with what `systemd-run` said; the unit
/// is stopped then.
pub fn start(
    unit: &TransientUnit,
    host: HostProgram,
    launch: &Launch,
    runtime_max: Option<Duration>,
    stop: &AtomicBool,
) -> Result<Started> {
    // SAFETY: geteuid has no arguments and cannot fail.
    let uid = unsafe { libc::geteuid() };
    let socket = ConnectSocket::create(&Folder::for_manager(unit.manager())?, uid)?;
    let hosted = hosted(
        host,
        &super::unit::program(unit.manager())?,
        socket.path(),
        launch,
    );
    let mut command = unit.command(runtime_max, &hosted);
    {
        use std::os::unix::process::CommandExt as _;
        // SAFETY: setsid is async-signal-safe. systemd-run leads its own
        // session, so it can be found and ended.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    let peer = Peer::new(uid, unit.name(), unit.manager());
    let connected = connect::start(socket, &peer, command, host.subcommand(), stop)?;
    let reading = connected.stream.try_clone()?;
    Ok(Started {
        channels: channels(reading)?,
        systemd_run: SystemdRun {
            child: Mutex::new(Some(connected.systemd_run)),
            stream: connected.stream,
        },
    })
}
