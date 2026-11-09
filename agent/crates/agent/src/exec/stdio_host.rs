//! `bmuster-agent stdio-host <socket> -- <program> <args>`: a command or
//! files session's unit program (SPEC-SESSION-UNITS, Version 2).
//!
//! It connects back to the agent and runs the program with pipes it makes
//! itself, inside the unit: `input` frames go to the program's stdin
//! (`input-closed` closes it), its stdout and stderr come back as their own
//! frames, and the exit code is the last frame. The program leads its own
//! session, so whatever it leaves running ends with it. When the socket
//! closes, the program is ended and the host exits.

use super::channel::{self, Frame};
use super::pty_host::launch_of;
use super::tree;
use anyhow::{Context as _, Result};
use std::ffi::OsString;
use std::io::{BufReader, Read, Write as _};
use std::os::unix::net::UnixStream;
use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

const CHUNK: usize = 64 * 1024;
/// How long to keep reading after the program ends, for output still in
/// the pipes (a background job may hold them open for ever).
const DRAIN: Duration = Duration::from_secs(1);

/// Connects to `socket` and runs `command` (program, then arguments).
pub fn run(socket: &Path, command: &[OsString]) -> Result<()> {
    let stream = UnixStream::connect(socket)
        .with_context(|| format!("could not connect to {}", socket.display()))?;
    serve(stream, command)
}

type Output = Arc<Mutex<UnixStream>>;

fn send(output: &Output, frame: &Frame) -> std::io::Result<()> {
    let mut stream = output.lock().unwrap_or_else(|p| p.into_inner());
    channel::write(&mut *stream, frame)
}

fn relay(mut source: impl Read, output: &Output, make: fn(Vec<u8>) -> Frame) {
    let mut buffer = vec![0u8; CHUNK];
    let mut forwarding = true;
    loop {
        match source.read(&mut buffer) {
            Ok(0) => return,
            Ok(n) => {
                if forwarding && send(output, &make(buffer[..n].to_vec())).is_err() {
                    // Keep reading so the program never blocks on a full pipe.
                    forwarding = false;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return,
        }
    }
}

/// Runs the program over `stream` until it ends or the agent closes the
/// connection.
pub fn serve(stream: UnixStream, command: &[OsString]) -> Result<()> {
    let output: Output = Arc::new(Mutex::new(stream.try_clone()?));
    let started = launch_of(command).and_then(|launch| {
        let mut command = Command::new(&launch.program.path);
        command
            .args(&launch.program.args)
            .current_dir(&launch.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // SAFETY: setsid is async-signal-safe. The program leads its own
        // session, so everything it starts can be found and ended.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        command
            .spawn()
            .with_context(|| format!("could not start {}", launch.program.path.display()))
    });
    let mut child = match started {
        Ok(child) => child,
        Err(error) => {
            let _ = send(&output, &Frame::Failed(format!("{error:#}")));
            return Err(error);
        }
    };
    let pid = libc::pid_t::try_from(child.id()).context("process id out of range")?;

    let (done, finished) = mpsc::channel::<()>();
    let mut readers = 0;
    for (source, make) in [
        (
            child
                .stdout
                .take()
                .map(|out| Box::new(out) as Box<dyn Read + Send>),
            Frame::Stdout as fn(Vec<u8>) -> Frame,
        ),
        (
            child
                .stderr
                .take()
                .map(|err| Box::new(err) as Box<dyn Read + Send>),
            Frame::Stderr,
        ),
    ] {
        if let Some(source) = source {
            let output = Arc::clone(&output);
            let done = done.clone();
            std::thread::Builder::new()
                .name("stdio output".into())
                .spawn(move || {
                    relay(source, &output, make);
                    let _ = done.send(());
                })?;
            readers += 1;
        }
    }
    drop(done);

    let stdin = child.stdin.take();
    let mut input = BufReader::new(stream.try_clone()?);
    std::thread::Builder::new()
        .name("stdio input".into())
        .spawn(move || {
            let mut stdin = stdin;
            loop {
                match channel::read(&mut input) {
                    Ok(Some(Frame::Input(bytes))) => {
                        let written = stdin
                            .as_mut()
                            .map(|pipe| pipe.write_all(&bytes).and_then(|()| pipe.flush()));
                        if matches!(written, Some(Err(_))) {
                            // The program stopped reading; later input is dropped.
                            stdin = None;
                        }
                    }
                    Ok(Some(Frame::InputClosed)) => stdin = None,
                    Ok(Some(other)) => {
                        log::warn!("The agent sent a host frame: {other:?}");
                        break;
                    }
                    Ok(None) => break,
                    Err(e) => {
                        log::debug!("The agent's connection ended: {e}");
                        break;
                    }
                }
            }
            // The agent is gone: so is the program.
            drop(stdin);
            tree::end_session(pid);
        })?;

    let status = child.wait().context("could not wait for the program");
    let until = Instant::now() + DRAIN;
    while readers > 0 {
        let left = until.saturating_duration_since(Instant::now());
        if finished.recv_timeout(left).is_err() {
            break;
        }
        readers -= 1;
    }
    // Anything it left running goes too; its output so far was sent.
    tree::end_session(pid);
    let last = match &status {
        Ok(status) => Frame::Exit(
            status
                .code()
                .or_else(|| status.signal().map(|signal| 128 + signal))
                .unwrap_or(-1),
        ),
        Err(error) => Frame::Failed(format!("{error:#}")),
    };
    let _ = send(&output, &last);
    let _ = stream.shutdown(std::net::Shutdown::Both);
    status.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::super::connect::{ConnectSocket, Folder, Peer, CONNECT_WAIT};
    use super::super::host::{channels, ExitState, InputWriter};
    use super::super::unit::Manager;
    use super::*;

    const UNIT: &str = "bmuster-exec-test.service";

    fn start(command: &[&str]) -> (UnixStream, std::thread::JoinHandle<Result<()>>) {
        let dir = tempfile::tempdir().unwrap();
        // SAFETY: geteuid cannot fail.
        let uid = unsafe { libc::geteuid() };
        let socket = ConnectSocket::create(&Folder::at(dir.path()), uid).unwrap();
        let path = socket.path().to_path_buf();
        let command: Vec<OsString> = command.iter().map(OsString::from).collect();
        let host = std::thread::spawn(move || run(&path, &command));
        let agent = socket
            .accept_checked(
                &Peer::new(uid, UNIT, Manager::System),
                CONNECT_WAIT,
                &mut || None,
                &|_| Ok(format!("0::/system.slice/{UNIT}\n")),
            )
            .unwrap();
        (agent, host)
    }

    fn read_all(mut reader: impl Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            reader.read_to_end(&mut bytes).unwrap();
            bytes
        })
    }

    /// CB5: stdin, stdout, stderr and the exit code, through the agent's
    /// own side of the channels.
    #[test]
    fn channels_round_trip() {
        let (stream, host) = start(&[
            "/bin/sh",
            "-c",
            "read line; echo out $line; echo err >&2; cat; exit 5",
        ]);
        let channels = channels(stream).unwrap();
        let out = read_all(channels.stdout);
        let err = read_all(channels.stderr);
        let mut input = InputWriter::new(channels.input.clone());
        input.write_all(b"one\n").unwrap();
        input.write_all(&vec![b'x'; 3 * 1024 * 1024]).unwrap();
        // Dropping the writer closes the input, so `cat` ends.
        drop(input);
        assert_eq!(channels.exit.wait(), ExitState::Code(5));
        let out = out.join().unwrap();
        assert!(out.starts_with(b"out one\n"));
        assert_eq!(
            out.len(),
            "out one\n".len() + 3 * 1024 * 1024,
            "big input passes whole"
        );
        assert_eq!(err.join().unwrap(), b"err\n");
        host.join().unwrap().unwrap();
    }

    #[test]
    fn a_closed_socket_ends_the_program() {
        let (stream, host) = start(&["/bin/sh", "-c", "sleep 300"]);
        let started = Instant::now();
        stream.shutdown(std::net::Shutdown::Both).unwrap();
        assert!(host.join().unwrap().is_ok());
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_program_that_cannot_start_says_why() {
        let (stream, host) = start(&["/no/such/program"]);
        let channels = channels(stream).unwrap();
        assert!(matches!(
            channels.exit.wait(),
            ExitState::Failed(message) if message.contains("/no/such/program")
        ));
        assert!(host.join().unwrap().is_err());
    }
}
