//! The live socket: a signed WebSocket the server uses to ask for a check-in
//! now, to watch the machine's load while a console page is open, and to
//! start sessions (each on a socket of its own, see `sessions`).

use crate::client::{parse_reply, Channel, Reply, Session, USER_AGENT};
use crate::inventory::Probe;
use crate::sessions::Sessions;
use crate::status::StatusBoard;
use crate::worker::{Backoff, Signal};
use anyhow::{bail, Context as _, Result};
use bmuster_protocol::{AgentMessage, RefusalReason, ServerMessage, SOCKET_PATH};
use std::io::ErrorKind;
use std::net::{TcpStream, ToSocketAddrs as _};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest as _;
use tungstenite::handshake::HandshakeError;
use tungstenite::http::HeaderValue;
use tungstenite::protocol::CloseFrame;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Connector, Message, WebSocket};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// How often the loop wakes to send pings and live figures and to notice a stop.
const TICK: Duration = Duration::from_millis(250);
const PING_EVERY: Duration = Duration::from_secs(30);
/// Nothing heard for this long (not even a pong): the connection is dead.
const SILENCE_LIMIT: Duration = Duration::from_secs(90);
/// A connection that lasted this long resets the back-off.
const STABLE_AFTER: Duration = Duration::from_secs(30);
const MIN_WATCH_INTERVAL_MS: u64 = 500;
/// Close reason the server uses when the machine is removed.
const REVOKED_CLOSE_REASON: &str = "revoked";

pub type Socket = WebSocket<MaybeTlsStream<TcpStream>>;

pub enum Connect {
    Open(Box<Socket>),
    Revoked(String),
}

enum Ended {
    Stopped,
    Closed,
    Revoked(String),
}

/// Keeps the socket open until `stop` is set or the machine is revoked.
pub fn run(
    session: &Session,
    sessions: &Sessions,
    signals: &Sender<Signal>,
    stop: &AtomicBool,
    board: &StatusBoard,
) {
    let mut backoff = Backoff::new(Duration::from_secs(1), Duration::from_secs(60));
    let mut probe = Probe::new();
    while !stop.load(Ordering::SeqCst) {
        let started = Instant::now();
        let result = match connect(session) {
            Ok(Connect::Open(socket)) => {
                log::info!("Live socket connected.");
                board.socket(true);
                let ended = serve(*socket, session, sessions, signals, stop, &mut probe);
                board.socket(false);
                ended
            }
            Ok(Connect::Revoked(message)) => Ok(Ended::Revoked(message)),
            Err(e) => Err(e),
        };
        match result {
            Ok(Ended::Stopped) => return,
            Ok(Ended::Revoked(message)) => {
                let _ = signals.send(Signal::Revoked(message));
                return;
            }
            Ok(Ended::Closed) => log::info!("Live socket closed by the server."),
            Err(e) => log::warn!("Live socket: {e:#}"),
        }
        if started.elapsed() >= STABLE_AFTER {
            backoff.reset();
        }
        let wait = backoff.next_wait();
        log::info!("Reconnecting the live socket in {} s.", wait.as_secs());
        if sleep_unless_stopped(wait, stop) {
            return;
        }
    }
}

/// Returns true if `stop` was set while waiting.
fn sleep_unless_stopped(wait: Duration, stop: &AtomicBool) -> bool {
    let until = Instant::now() + wait;
    while Instant::now() < until {
        if stop.load(Ordering::SeqCst) {
            return true;
        }
        std::thread::sleep(TICK.min(until.saturating_duration_since(Instant::now())));
    }
    stop.load(Ordering::SeqCst)
}

fn open_tcp(host: &str, port: u16) -> Result<TcpStream> {
    let addresses: Vec<_> = (host, port)
        .to_socket_addrs()
        .with_context(|| format!("could not resolve {host}"))?
        .collect();
    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
            Ok(stream) => return Ok(stream),
            Err(e) => last_error = Some(e),
        }
    }
    match last_error {
        Some(e) => Err(e).with_context(|| format!("could not connect to {host}:{port}")),
        None => bail!("{host} has no addresses"),
    }
}

pub fn tcp_of(socket: &mut Socket) -> Result<&mut TcpStream> {
    match socket.get_mut() {
        MaybeTlsStream::Plain(stream) => Ok(stream),
        MaybeTlsStream::Rustls(stream) => Ok(&mut stream.sock),
        _ => bail!("unexpected socket stream type"),
    }
}

/// Opens the live socket, following a planned certificate change (L7).
fn connect(session: &Session) -> Result<Connect> {
    connect_to(session, SOCKET_PATH)
}

/// Opens a signed socket at `path` (the live socket or a session's own),
/// following a planned certificate change (L7).
pub fn connect_to(session: &Session, path: &str) -> Result<Connect> {
    session
        .transport
        .exchange(|channel| connect_with(session, channel, path))
}

/// Opens a socket with a signed upgrade request (`GET`, empty body).
fn connect_with(session: &Session, channel: &Channel, path: &str) -> Result<Connect> {
    let server = &session.transport.server;
    let mut request = server
        .ws_url(path)
        .into_client_request()
        .context("bad socket URL")?;
    let tcp = open_tcp(server.host(), server.port())?;
    tcp.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    tcp.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;
    tcp.set_nodelay(true)?;

    let signed = session.sign("GET", path, b"");
    request.headers_mut().insert(
        "authorization",
        HeaderValue::from_str(&signed.authorization).context("bad authorization header")?,
    );
    request
        .headers_mut()
        .insert("user-agent", HeaderValue::from_static(USER_AGENT));
    let connector = Connector::Rustls(channel.websocket_tls.clone());
    let result = tungstenite::client_tls_with_config(request, tcp, None, Some(connector));
    drop(signed);

    let mut socket = match result {
        Ok((socket, response)) => {
            session.observe_date(date_of(response.headers()));
            socket
        }
        Err(HandshakeError::Failure(tungstenite::Error::Http(response))) => {
            session.observe_date(date_of(response.headers()));
            let status = response.status().as_u16();
            let body = response
                .body()
                .as_deref()
                .map(String::from_utf8_lossy)
                .unwrap_or_default();
            return match parse_reply::<serde_json::Value>(status, &body)? {
                Reply::Refused(refusal) if refusal.reason == RefusalReason::Revoked => {
                    Ok(Connect::Revoked(refusal.message))
                }
                Reply::Refused(refusal) => bail!(
                    "the server refused the socket: {} ({})",
                    refusal.message,
                    refusal.reason
                ),
                Reply::Ok(_) => bail!("the server answered the upgrade with HTTP 200"),
            };
        }
        Err(HandshakeError::Failure(e)) => return Err(e).context("socket handshake failed"),
        Err(HandshakeError::Interrupted(_)) => bail!("socket handshake timed out"),
    };
    let tcp = tcp_of(&mut socket)?;
    tcp.set_read_timeout(Some(TICK))?;
    Ok(Connect::Open(Box::new(socket)))
}

/// A message box on the console's screen (Windows), on its own thread so the
/// live socket never waits for it.
fn show_user_message(from: String, text: String) {
    log::info!("{from} sent a message to the person at this machine");
    #[cfg(windows)]
    {
        let shown = std::thread::Builder::new()
            .name("user-message".into())
            .spawn(move || {
                let title = format!("Message from {from} (BMuster)");
                if let Err(error) =
                    bmuster_desktop::winsession::console::send_message(&title, &text)
                {
                    log::warn!("Could not show the message: {error}");
                }
            });
        if let Err(error) = shown {
            log::warn!("Could not show the message: {error}");
        }
    }
    #[cfg(not(windows))]
    {
        let _ = text;
        log::warn!("Messages to the screen are shown on Windows only; this one was dropped");
    }
}

fn date_of(headers: &tungstenite::http::HeaderMap) -> Option<&str> {
    headers.get("date").and_then(|value| value.to_str().ok())
}

fn is_timeout(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(e)
        if e.kind() == ErrorKind::WouldBlock || e.kind() == ErrorKind::TimedOut)
}

fn serve(
    mut socket: Socket,
    session: &Session,
    sessions: &Sessions,
    signals: &Sender<Signal>,
    stop: &AtomicBool,
    probe: &mut Probe,
) -> Result<Ended> {
    let mut next_ping = Instant::now() + PING_EVERY;
    let mut last_heard = Instant::now();
    // (interval, next send) while a console page is watching.
    let mut watch: Option<(Duration, Instant)> = None;

    loop {
        if stop.load(Ordering::SeqCst) {
            let _ = socket.close(None);
            let _ = socket.flush();
            return Ok(Ended::Stopped);
        }
        let now = Instant::now();
        if now.duration_since(last_heard) > SILENCE_LIMIT {
            bail!(
                "nothing heard from the server for {} s",
                SILENCE_LIMIT.as_secs()
            );
        }
        if now >= next_ping {
            socket
                .send(Message::Ping(Vec::new().into()))
                .context("could not send a ping")?;
            next_ping = now + PING_EVERY;
        }
        if let Some((interval, due)) = watch {
            if now >= due {
                let load = probe.load();
                let message = AgentMessage::Live {
                    cpu_percent: load.cpu_percent,
                    memory_used_bytes: load.memory_used_bytes,
                };
                socket
                    .send(Message::text(serde_json::to_string(&message)?))
                    .context("could not send live figures")?;
                watch = Some((interval, now + interval));
            }
        }

        let message = match socket.read() {
            Ok(message) => message,
            Err(e) if is_timeout(&e) => continue,
            Err(tungstenite::Error::ConnectionClosed) => return Ok(Ended::Closed),
            Err(e) => return Err(e).context("socket read failed"),
        };
        last_heard = Instant::now();
        match message {
            Message::Text(text) => match serde_json::from_str::<ServerMessage>(text.as_str()) {
                Ok(ServerMessage::CheckInNow) => {
                    log::debug!("The server asked for a check-in now.");
                    if signals.send(Signal::CheckInNow).is_err() {
                        return Ok(Ended::Stopped);
                    }
                }
                Ok(ServerMessage::Watch { interval_ms }) => {
                    if interval_ms < MIN_WATCH_INTERVAL_MS {
                        log::warn!(
                            "Ignoring watch every {interval_ms} ms; the minimum is \
                             {MIN_WATCH_INTERVAL_MS} ms."
                        );
                    } else {
                        log::debug!("Watched: sending load every {interval_ms} ms.");
                        watch = Some((Duration::from_millis(interval_ms), Instant::now()));
                    }
                }
                Ok(ServerMessage::Unwatch) => {
                    log::debug!("No longer watched.");
                    watch = None;
                }
                Ok(ServerMessage::PinUpdate { next }) => session.transport.announce(next),
                Ok(ServerMessage::UserMessage { from, text }) => show_user_message(from, text),
                Ok(ServerMessage::SessionOpen { ticket, signature }) => {
                    if let Err(refused) = sessions.open(&ticket, &signature) {
                        log::warn!("{}", refused.message);
                        if let Some(session_id) = refused.session_id {
                            let message = AgentMessage::SessionRefused {
                                session_id,
                                message: refused.message,
                            };
                            socket
                                .send(Message::text(serde_json::to_string(&message)?))
                                .context("could not refuse a session")?;
                        }
                    }
                }
                Err(e) => log::warn!("Ignoring a socket message this agent does not know: {e}"),
            },
            Message::Close(frame) => {
                return Ok(match frame {
                    Some(CloseFrame { reason, .. }) if reason.as_str() == REVOKED_CLOSE_REASON => {
                        Ended::Revoked("the server closed the live socket as revoked.".into())
                    }
                    _ => Ended::Closed,
                });
            }
            Message::Binary(_) => log::warn!("Ignoring a binary socket message."),
            Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
        }
    }
}
