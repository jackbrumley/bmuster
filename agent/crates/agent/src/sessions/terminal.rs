//! A terminal session: a shell on a pseudo-terminal, its bytes on the
//! session socket (SPEC-SESSIONS T1, T6).
//!
//! Threads: the pump (socket), a reader (terminal → socket), a writer
//! (socket → terminal, so a shell that is not reading never blocks the
//! socket) and a waiter (the shell's exit). When the shell exits, everything
//! it started is ended too, and the exit code is the last message.

use super::pump::{pump, Ended, Incoming, Outgoing};
use crate::exec::pty::{is_hangup, Pty, Spawned};
use crate::exec::spawn::{agent_account, environment, interactive, Launch};
use crate::exec::PtySize;
use crate::socket::Socket;
use anyhow::Result;
use bmuster_protocol::session::{SessionControl, SessionEvent, Shell};
use std::fs::File;
use std::io::{Read as _, Write as _};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::Arc;
use std::time::Duration;

/// Bytes read from the terminal at a time (one frame at most).
const CHUNK: usize = 16 * 1024;
/// Frames waiting for the socket before the reader blocks.
const OUTPUT_QUEUE: usize = 16;
/// Input waiting for the shell before the socket stops being read.
const INPUT_LIMIT: usize = 1024 * 1024;
/// After the shell exits, how long to wait for its last output.
const LAST_OUTPUT_WAIT: Duration = Duration::from_secs(1);

/// What to start.
pub struct Request<'a> {
    pub shell: Shell,
    pub size: PtySize,
    /// The console user's name, for `BMUSTER_USER`.
    pub console_user: &'a str,
}

/// Starts the shell. Errors here are reported to the console as `failed`.
pub fn start(request: &Request<'_>) -> Result<Spawned> {
    let account = agent_account();
    let program = interactive(request.shell)?;
    let env = environment(&account, &program, request.console_user, true);
    let launch = Launch {
        program,
        env,
        cwd: account.home,
    };
    Pty::spawn(&launch, request.size)
}

/// Runs a started shell over `socket` until it exits, the server ends the
/// session, or `stop`. The shell and everything it started end either way.
pub fn run(socket: &mut Socket, spawned: Spawned, stop: &AtomicBool) -> Result<Ended> {
    let Spawned {
        pty,
        mut process,
        reader,
        writer,
    } = spawned;
    let pty = Arc::new(pty);
    let (output, outgoing) = mpsc::sync_channel::<Outgoing>(OUTPUT_QUEUE);
    let (reader_done, reader_finished) = mpsc::channel::<()>();

    {
        let output = output.clone();
        spawn("terminal-read", move || {
            read_terminal(reader, &output);
            let _ = reader_done.send(());
        })?;
    }
    {
        let pty = Arc::clone(&pty);
        spawn("terminal-wait", move || {
            let event = match process.wait() {
                Ok(code) => SessionEvent::Exited { code },
                Err(e) => SessionEvent::Failed {
                    message: format!("{e:#}"),
                },
            };
            pty.end();
            let _ = reader_finished.recv_timeout(LAST_OUTPUT_WAIT);
            let _ = output.send(Outgoing::Done(event));
        })?;
    }
    let queued = Arc::new(AtomicUsize::new(0));
    let (input, input_inbox) = mpsc::channel::<Vec<u8>>();
    {
        let queued = Arc::clone(&queued);
        spawn("terminal-write", move || {
            write_terminal(writer, &input_inbox, &queued);
        })?;
    }

    let ended = pump(
        socket,
        &outgoing,
        stop,
        || queued.load(Ordering::SeqCst) < INPUT_LIMIT,
        |message| {
            match message {
                Incoming::Bytes(bytes) => {
                    queued.fetch_add(bytes.len(), Ordering::SeqCst);
                    // The writer only stops when the terminal is gone; the
                    // waiter then ends the session.
                    let _ = input.send(bytes);
                }
                Incoming::Text(text) => match serde_json::from_str::<SessionControl>(&text) {
                    Ok(SessionControl::Resize { cols, rows }) => {
                        pty.resize(PtySize::clamped(cols, rows))?;
                    }
                    Err(e) => {
                        log::warn!("Ignoring a session message this agent does not know: {e}");
                    }
                },
            }
            Ok(())
        },
    );
    pty.end();
    ended
}

fn spawn(name: &str, work: impl FnOnce() + Send + 'static) -> Result<()> {
    std::thread::Builder::new()
        .name(name.into())
        .spawn(work)
        .map(|_| ())
        .map_err(Into::into)
}

/// Terminal → socket. Once the socket side is gone it keeps reading and
/// dropping, so a shell (or ConPTY's close) never waits on a full buffer.
fn read_terminal(mut reader: File, output: &SyncSender<Outgoing>) {
    let mut buffer = vec![0u8; CHUNK];
    let mut forwarding = true;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => return,
            Ok(n) => {
                if forwarding && output.send(Outgoing::Bytes(buffer[..n].to_vec())).is_err() {
                    forwarding = false;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => {
                if !is_hangup(&e) {
                    log::debug!("Terminal read ended: {e}");
                }
                return;
            }
        }
    }
}

/// Socket → terminal.
fn write_terminal(mut writer: File, inbox: &mpsc::Receiver<Vec<u8>>, queued: &AtomicUsize) {
    for bytes in inbox {
        let result = writer.write_all(&bytes).and_then(|()| writer.flush());
        queued.fetch_sub(bytes.len(), Ordering::SeqCst);
        if let Err(e) = result {
            log::debug!("Terminal write ended: {e}");
            return;
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::testing::{socket_pair, Server};
    use super::*;
    use std::time::Instant;

    fn start_sh(cols: u16, rows: u16) -> Spawned {
        start(&Request {
            shell: Shell::Sh,
            size: PtySize { cols, rows },
            console_user: "tester",
        })
        .unwrap()
    }

    #[test]
    fn a_shell_runs_resizes_and_reports_its_exit_code() {
        let (mut client, server) = socket_pair();
        let spawned = start_sh(80, 24);
        let agent = std::thread::spawn(move || {
            let stop = AtomicBool::new(false);
            run(&mut client, spawned, &stop).unwrap()
        });
        let mut server = Server::new(server);
        server.send_bytes(b"echo $((6*7)) $BMUSTER_USER\n");
        server.wait_for_output("42 tester");
        server.send_text(r#"{"type":"resize","cols":120,"rows":40}"#);
        server.send_bytes(b"stty size\n");
        server.wait_for_output("40 120");
        server.send_bytes(b"exit 7\n");
        assert_eq!(server.wait_for_text(), r#"{"type":"exited","code":7}"#);
        assert_eq!(agent.join().unwrap(), Ended::Finished);
    }

    #[test]
    fn closing_the_socket_ends_the_shell_and_its_background_jobs() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let (mut client, server) = socket_pair();
        let spawned = start_sh(80, 24);
        let agent = std::thread::spawn(move || {
            let stop = AtomicBool::new(false);
            run(&mut client, spawned, &stop).unwrap()
        });
        let mut server = Server::new(server);
        server.send_bytes(
            format!(
                "sleep 300 & echo $! > {} && echo st''arted\n",
                pid_file.display()
            )
            .as_bytes(),
        );
        server.wait_for_output("started");
        let pid: libc::pid_t = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        server.close();
        assert_eq!(agent.join().unwrap(), Ended::ServerClosed);
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
    fn a_fast_producer_can_be_interrupted_after_a_pause() {
        let (mut client, server) = socket_pair();
        let spawned = start_sh(80, 24);
        let agent = std::thread::spawn(move || {
            let stop = AtomicBool::new(false);
            run(&mut client, spawned, &stop).unwrap()
        });
        let mut server = Server::new(server);
        server.send_bytes(b"yes\n");
        server.wait_for_output("y\r\ny\r\ny\r\n");
        // Nobody reads for a while (pump_tests prove the producer pauses).
        std::thread::sleep(Duration::from_secs(2));
        server.send_bytes(b"\x03");
        server.send_bytes(b"exit 0\n");
        assert_eq!(server.wait_for_text(), r#"{"type":"exited","code":0}"#);
        assert_eq!(agent.join().unwrap(), Ended::Finished);
    }
}
