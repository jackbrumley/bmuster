//! Moving one session's bytes over its own socket, on one thread.
//!
//! The socket is blocking with a short timeout, so one loop can both send
//! what the session produced and read what the browser sent. Backpressure:
//! output is taken from a bounded channel only when the socket has flushed
//! everything before it, so a slow browser (the server pauses reading from
//! this socket) fills the channel, which blocks the session's reader thread,
//! which leaves the terminal's buffer full, which pauses the shell. Input is
//! read only while the session can take it (`accept_input`).

use crate::socket::{tcp_of, Socket};
use anyhow::{bail, Context as _, Result};
use bmuster_protocol::session::SessionEvent;
use std::io::ErrorKind;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::{Duration, Instant};
use tungstenite::Message;

/// How long one read waits; also the longest delay before new output is sent.
const READ_WAIT: Duration = Duration::from_millis(10);
/// The most output sent before the loop reads again.
const BATCH: usize = 256 * 1024;
/// Nothing heard (the server pings every 30 s): the connection is dead.
const SILENCE_LIMIT: Duration = Duration::from_secs(90);
/// How long the closing handshake may take.
const CLOSE_WAIT: Duration = Duration::from_secs(2);

/// What the session sends.
pub enum Outgoing {
    Bytes(Vec<u8>),
    /// A JSON message (a file session's replies).
    Text(String),
    /// The last message: sent, then the socket is closed.
    Done(SessionEvent),
}

/// What the server sent. Text frames are JSON whose meaning depends on the
/// session kind, so each kind reads them itself.
pub enum Incoming {
    Bytes(Vec<u8>),
    Text(String),
}

/// Why the pump stopped.
#[derive(Debug, PartialEq, Eq)]
pub enum Ended {
    /// The session finished and said so.
    Finished,
    /// The server closed the socket: the session was ended from the console.
    ServerClosed,
    /// The agent is stopping.
    Stopped,
}

fn would_block(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(e)
        if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut)
}

/// Writes or flushes; false when the socket is full and the rest waits.
fn sent(result: tungstenite::Result<()>) -> Result<bool> {
    match result {
        Ok(()) => Ok(true),
        Err(e) if would_block(&e) => Ok(false),
        Err(e) => Err(e).context("could not send on the session socket"),
    }
}

/// Runs until the session is done, the server closes, or `stop`.
pub fn pump(
    socket: &mut Socket,
    outgoing: &Receiver<Outgoing>,
    stop: &AtomicBool,
    mut accept_input: impl FnMut() -> bool,
    mut incoming: impl FnMut(Incoming) -> Result<()>,
) -> Result<Ended> {
    let tcp = tcp_of(socket)?;
    tcp.set_read_timeout(Some(READ_WAIT))?;
    tcp.set_write_timeout(Some(READ_WAIT))?;
    tcp.set_nodelay(true)?;

    let mut unflushed = false;
    let mut finishing = false;
    let mut last_heard = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            close(socket);
            return Ok(Ended::Stopped);
        }
        if last_heard.elapsed() > SILENCE_LIMIT {
            bail!(
                "nothing heard from the server for {} s",
                SILENCE_LIMIT.as_secs()
            );
        }
        if unflushed {
            unflushed = !sent(socket.flush())?;
        }
        if !unflushed && !finishing {
            let mut budget = BATCH;
            let mut wrote = false;
            while budget > 0 {
                let message = match outgoing.try_recv() {
                    Ok(Outgoing::Bytes(bytes)) => {
                        budget = budget.saturating_sub(bytes.len());
                        Message::Binary(bytes.into())
                    }
                    Ok(Outgoing::Text(text)) => Message::text(text),
                    Ok(Outgoing::Done(event)) => {
                        finishing = true;
                        Message::text(serde_json::to_string(&event)?)
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        finishing = true;
                        break;
                    }
                };
                wrote = true;
                if !sent(socket.write(message))? {
                    unflushed = true;
                    break;
                }
                if finishing {
                    break;
                }
            }
            if wrote && !unflushed {
                unflushed = !sent(socket.flush())?;
            }
        }
        if finishing && !unflushed {
            close(socket);
            return Ok(Ended::Finished);
        }
        if !accept_input() {
            // Not reading on purpose: the silence is ours, not the server's.
            last_heard = Instant::now();
            std::thread::sleep(READ_WAIT);
            continue;
        }
        let message = match socket.read() {
            Ok(message) => message,
            Err(e) if would_block(&e) => continue,
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                return Ok(Ended::ServerClosed)
            }
            Err(e) => return Err(e).context("could not read the session socket"),
        };
        last_heard = Instant::now();
        match message {
            Message::Binary(bytes) => incoming(Incoming::Bytes(bytes.to_vec()))?,
            Message::Text(text) => incoming(Incoming::Text(text.as_str().to_string()))?,
            Message::Close(_) => {
                close(socket);
                return Ok(Ended::ServerClosed);
            }
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }
}

/// Starts the closing handshake and waits briefly for it to finish.
fn close(socket: &mut Socket) {
    let _ = socket.close(None);
    let until = Instant::now() + CLOSE_WAIT;
    while Instant::now() < until {
        match socket.read() {
            Ok(_) => {}
            Err(e) if would_block(&e) => {
                let _ = socket.flush();
            }
            Err(_) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::testing::{socket_pair, Server};
    use super::*;
    use bmuster_protocol::session::SessionControl;
    use std::sync::atomic::AtomicUsize;
    use std::sync::{mpsc, Arc};

    #[test]
    fn a_reader_that_stops_reading_pauses_the_producer() {
        let (mut client, server) = socket_pair();
        let (output, outgoing) = mpsc::sync_channel::<Outgoing>(16);
        let produced = Arc::new(AtomicUsize::new(0));
        {
            let produced = Arc::clone(&produced);
            std::thread::spawn(move || {
                while output.send(Outgoing::Bytes(vec![b'y'; 16 * 1024])).is_ok() {
                    produced.fetch_add(16 * 1024, Ordering::SeqCst);
                }
            });
        }
        let agent = std::thread::spawn(move || {
            let stop = AtomicBool::new(false);
            pump(&mut client, &outgoing, &stop, || true, |_| Ok(())).unwrap()
        });
        let mut server = Server::new(server);
        // The server reads nothing: the socket buffers fill, then the producer stops.
        std::thread::sleep(Duration::from_secs(1));
        let paused_at = produced.load(Ordering::SeqCst);
        std::thread::sleep(Duration::from_secs(1));
        assert_eq!(
            produced.load(Ordering::SeqCst),
            paused_at,
            "the producer is paused"
        );
        assert!(
            paused_at < 64 * 1024 * 1024,
            "{paused_at} bytes made before pausing"
        );
        // Reading again lets it go on.
        server.skip_bytes(paused_at + 1024 * 1024);
        assert!(produced.load(Ordering::SeqCst) > paused_at);
        server.close();
        assert_eq!(agent.join().unwrap(), Ended::ServerClosed);
    }

    #[test]
    fn the_last_event_is_sent_then_the_socket_closes() {
        let (mut client, server) = socket_pair();
        let (output, outgoing) = mpsc::sync_channel::<Outgoing>(4);
        output.send(Outgoing::Bytes(b"hello".to_vec())).unwrap();
        output
            .send(Outgoing::Done(SessionEvent::Exited { code: 0 }))
            .unwrap();
        let agent = std::thread::spawn(move || {
            let stop = AtomicBool::new(false);
            pump(&mut client, &outgoing, &stop, || true, |_| Ok(())).unwrap()
        });
        let mut server = Server::new(server);
        server.wait_for_output("hello");
        assert_eq!(server.output(), b"hello");
        assert_eq!(server.wait_for_text(), r#"{"type":"exited","code":0}"#);
        server.close();
        assert_eq!(agent.join().unwrap(), Ended::Finished);
    }

    #[test]
    fn input_and_control_messages_reach_the_session() {
        let (mut client, server) = socket_pair();
        let (output, outgoing) = mpsc::sync_channel::<Outgoing>(4);
        let (heard, inbox) = mpsc::channel::<String>();
        let agent = std::thread::spawn(move || {
            let stop = AtomicBool::new(false);
            pump(
                &mut client,
                &outgoing,
                &stop,
                || true,
                |message| {
                    let text = match message {
                        Incoming::Bytes(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
                        Incoming::Text(text) => {
                            match serde_json::from_str::<SessionControl>(&text) {
                                Ok(SessionControl::Resize { cols, rows }) => {
                                    format!("{cols}x{rows}")
                                }
                                Err(_) => return Ok(()),
                            }
                        }
                    };
                    heard.send(text)?;
                    Ok(())
                },
            )
            .unwrap()
        });
        let mut server = Server::new(server);
        server.send_bytes(b"ls\r");
        server.send_text(r#"{"type":"something-new"}"#);
        server.send_text(r#"{"type":"resize","cols":100,"rows":30}"#);
        let wait = Duration::from_secs(10);
        assert_eq!(inbox.recv_timeout(wait).unwrap(), "ls\r");
        assert_eq!(
            inbox.recv_timeout(wait).unwrap(),
            "100x30",
            "unknown messages are skipped"
        );
        output
            .send(Outgoing::Done(SessionEvent::Exited { code: 0 }))
            .unwrap();
        server.wait_for_text();
        server.close();
        assert_eq!(agent.join().unwrap(), Ended::Finished);
    }
}
