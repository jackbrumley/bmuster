//! `bmuster-agent pty-host <socket> -- <shell> -l`: a terminal session's
//! unit program (SPEC-SESSION-UNITS, Version 2).
//!
//! It connects back to the agent, waits for the terminal's size, makes the
//! pty itself, inside the unit, and starts the shell on it as its
//! controlling terminal. systemd never sees the pty, so SELinux's rule that
//! `init_t` may not open the agent's pty never comes into it. Screen bytes
//! go out as `stdout` frames, keys and resizes come in, and the shell's
//! exit code is the last frame. When the socket closes, the shell and
//! everything it started are ended and the host exits.

use super::channel::{self, Frame};
use super::placement::Placement;
use super::pty::{is_hangup, Pty, Spawned};
use super::spawn::{Launch, Program};
use anyhow::{bail, Context as _, Result};
use std::ffi::OsString;
use std::io::{BufReader, Read as _, Write as _};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Bytes read from the terminal at a time.
const CHUNK: usize = 16 * 1024;
/// Input chunks waiting for the shell before the socket stops being read.
const INPUT_QUEUE: usize = 64;
/// After the shell exits, how long to wait for its last output.
const LAST_OUTPUT_WAIT: Duration = Duration::from_secs(1);

/// Connects to `socket` and runs `command` (program, then arguments).
pub fn run(socket: &Path, command: &[OsString]) -> Result<()> {
    let stream = UnixStream::connect(socket)
        .with_context(|| format!("could not connect to {}", socket.display()))?;
    serve(stream, command)
}

/// The program and its arguments, with this process's environment and
/// folder (the unit's).
pub(super) fn launch_of(command: &[OsString]) -> Result<Launch> {
    let Some((program, args)) = command.split_first() else {
        bail!("no program to run");
    };
    Ok(Launch {
        program: Program {
            path: PathBuf::from(program),
            arg0: program.clone(),
            args: args.to_vec(),
        },
        env: std::env::vars_os().collect(),
        cwd: std::env::current_dir().context("could not read the working folder")?,
    })
}

type Output = Arc<Mutex<UnixStream>>;

fn send(output: &Output, frame: &Frame) -> std::io::Result<()> {
    let mut stream = output.lock().unwrap_or_else(|p| p.into_inner());
    channel::write(&mut *stream, frame)
}

/// Serves one terminal over `stream` until the shell exits or the agent
/// closes the connection.
pub fn serve(stream: UnixStream, command: &[OsString]) -> Result<()> {
    let output: Output = Arc::new(Mutex::new(stream.try_clone()?));
    let mut input = BufReader::new(stream.try_clone()?);
    let size = match channel::read(&mut input)? {
        Some(Frame::Resize(size)) => size,
        Some(other) => bail!("the agent sent {other:?} before the terminal's size"),
        None => return Ok(()),
    };
    let spawned =
        launch_of(command).and_then(|launch| Pty::spawn(&launch, Placement::InProcess, size));
    let Spawned {
        pty,
        mut process,
        mut reader,
        mut writer,
    } = match spawned {
        Ok(spawned) => spawned,
        Err(error) => {
            let _ = send(&output, &Frame::Failed(format!("{error:#}")));
            return Err(error);
        }
    };
    let pty = Arc::new(pty);

    let (read_done, read_finished) = mpsc::channel::<()>();
    {
        let output = Arc::clone(&output);
        std::thread::Builder::new()
            .name("pty output".into())
            .spawn(move || {
                let mut buffer = vec![0u8; CHUNK];
                let mut forwarding = true;
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            if forwarding
                                && send(&output, &Frame::Stdout(buffer[..n].to_vec())).is_err()
                            {
                                // Keep reading so the shell never blocks.
                                forwarding = false;
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(e) => {
                            if !is_hangup(&e) {
                                log::debug!("Terminal read ended: {e}");
                            }
                            break;
                        }
                    }
                }
                let _ = read_done.send(());
            })?;
    }
    let (keys, typed) = mpsc::sync_channel::<Vec<u8>>(INPUT_QUEUE);
    std::thread::Builder::new()
        .name("pty input".into())
        .spawn(move || {
            for bytes in typed {
                if writer
                    .write_all(&bytes)
                    .and_then(|()| writer.flush())
                    .is_err()
                {
                    return;
                }
            }
        })?;
    {
        let pty = Arc::clone(&pty);
        std::thread::Builder::new()
            .name("pty socket".into())
            .spawn(move || {
                loop {
                    match channel::read(&mut input) {
                        Ok(Some(Frame::Input(bytes))) => {
                            if keys.send(bytes).is_err() {
                                break;
                            }
                        }
                        Ok(Some(Frame::Resize(size))) => {
                            if let Err(e) = pty.resize(size) {
                                log::warn!("{e:#}");
                            }
                        }
                        Ok(Some(Frame::InputClosed)) => {}
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
                // The agent is gone: so is the shell.
                pty.end();
            })?;
    }
    let code = process.wait();
    // Background jobs go with the shell, as in the agent's own terminals.
    pty.end();
    let _ = read_finished.recv_timeout(LAST_OUTPUT_WAIT);
    let last = match &code {
        Ok(code) => Frame::Exit(*code),
        Err(error) => Frame::Failed(format!("{error:#}")),
    };
    let _ = send(&output, &last);
    let _ = stream.shutdown(std::net::Shutdown::Both);
    code.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::super::connect::{ConnectSocket, Folder, Peer, CONNECT_WAIT};
    use super::super::unit::Manager;
    use super::super::PtySize;
    use super::*;
    use std::time::Instant;

    const UNIT: &str = "bmuster-terminal-test.service";

    /// The agent's end and a pty-host serving `sh` on the other, joined by
    /// a real connect socket that passed the peer check.
    fn start() -> (UnixStream, std::thread::JoinHandle<Result<()>>) {
        let dir = tempfile::tempdir().unwrap();
        // SAFETY: geteuid cannot fail.
        let uid = unsafe { libc::geteuid() };
        let socket = ConnectSocket::create(&Folder::at(dir.path()), uid).unwrap();
        let path = socket.path().to_path_buf();
        let host = std::thread::spawn(move || run(&path, &[OsString::from("/bin/sh")]));
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

    struct Agent {
        stream: UnixStream,
        frames: mpsc::Receiver<Frame>,
        shown: String,
    }

    impl Agent {
        fn new(stream: UnixStream) -> Agent {
            let (send, frames) = mpsc::channel();
            let mut reading = BufReader::new(stream.try_clone().unwrap());
            std::thread::spawn(move || {
                while let Ok(Some(frame)) = channel::read(&mut reading) {
                    if send.send(frame).is_err() {
                        return;
                    }
                }
            });
            Agent {
                stream,
                frames,
                shown: String::new(),
            }
        }

        fn send(&mut self, frame: &Frame) {
            channel::write(&mut self.stream, frame).unwrap();
        }

        fn keys(&mut self, text: &str) {
            self.send(&Frame::Input(text.as_bytes().to_vec()));
        }

        /// Reads frames until the screen shows `text`; the exit, if one comes.
        fn wait_for(&mut self, text: &str) {
            let until = Instant::now() + Duration::from_secs(10);
            while !self.shown.contains(text) {
                let left = until.saturating_duration_since(Instant::now());
                match self.frames.recv_timeout(left) {
                    Ok(Frame::Stdout(bytes)) => {
                        self.shown.push_str(&String::from_utf8_lossy(&bytes))
                    }
                    Ok(other) => panic!("{other:?} while waiting for {text:?}: {}", self.shown),
                    Err(_) => panic!("{text:?} never showed: {}", self.shown),
                }
            }
        }

        fn exit(&mut self) -> Frame {
            loop {
                match self.frames.recv_timeout(Duration::from_secs(10)).unwrap() {
                    Frame::Stdout(bytes) => self.shown.push_str(&String::from_utf8_lossy(&bytes)),
                    other => return other,
                }
            }
        }
    }

    /// CB4: a controlling terminal, resizes and the exit code.
    #[test]
    fn shell_round_trip() {
        let (stream, host) = start();
        let mut agent = Agent::new(stream);
        agent.send(&Frame::Resize(PtySize { cols: 80, rows: 24 }));
        // /dev/tty opens only on a controlling terminal.
        agent.keys("exec 3</dev/tty && echo ctty-y''es; stty size\n");
        agent.wait_for("ctty-yes");
        agent.wait_for("24 80");
        agent.send(&Frame::Resize(PtySize {
            cols: 132,
            rows: 43,
        }));
        agent.keys("stty size\n");
        agent.wait_for("43 132");
        agent.keys("exit 7\n");
        assert_eq!(agent.exit(), Frame::Exit(7));
        host.join().unwrap().unwrap();
    }

    #[test]
    fn a_closed_socket_ends_the_shell_and_its_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let (stream, host) = start();
        let mut agent = Agent::new(stream);
        agent.send(&Frame::Resize(PtySize { cols: 80, rows: 24 }));
        agent.keys(&format!(
            "sleep 300 & echo $! > {} && echo st''arted\n",
            pid_file.display()
        ));
        agent.wait_for("started");
        let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        agent.stream.shutdown(std::net::Shutdown::Both).unwrap();
        // The host ends (the shell was hung up), and so does the job.
        assert!(host.join().unwrap().is_ok());
        let until = Instant::now() + Duration::from_secs(5);
        // SAFETY: signal 0 only asks whether the process exists.
        while unsafe { libc::kill(pid, 0) } == 0 && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_ne!(
            unsafe { libc::kill(pid, 0) },
            0,
            "the background sleep was ended"
        );
    }

    #[test]
    fn a_program_that_cannot_start_says_why() {
        let dir = tempfile::tempdir().unwrap();
        // SAFETY: geteuid cannot fail.
        let uid = unsafe { libc::geteuid() };
        let socket = ConnectSocket::create(&Folder::at(dir.path()), uid).unwrap();
        let path = socket.path().to_path_buf();
        let host = std::thread::spawn(move || run(&path, &[OsString::from("/no/such/shell")]));
        let stream = socket
            .accept_checked(
                &Peer::new(uid, UNIT, Manager::System),
                CONNECT_WAIT,
                &mut || None,
                &|_| Ok(format!("0::/system.slice/{UNIT}\n")),
            )
            .unwrap();
        let mut agent = Agent::new(stream);
        agent.send(&Frame::Resize(PtySize { cols: 80, rows: 24 }));
        assert!(
            matches!(agent.exit(), Frame::Failed(message) if message.contains("/no/such/shell"))
        );
        assert!(host.join().unwrap().is_err());
    }
}
