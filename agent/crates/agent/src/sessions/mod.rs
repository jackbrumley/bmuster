//! Remote sessions (SPEC-SESSIONS): the server asks on the live socket with
//! a signed ticket; the agent checks it, opens the session's own socket and
//! runs what the ticket is for on its own thread, so a busy session never
//! blocks the live socket.
//!
//! Every session kind shares this path: [`Sessions::open`] checks the
//! ticket, [`pump`] moves the bytes, and the kind's module (terminal, exec;
//! files later) decides what the bytes mean.

mod exec;
mod pump;
mod terminal;
#[cfg(test)]
mod testing;

use crate::client::Session;
use crate::exec::pipe::Limits;
use crate::exec::PtySize;
use crate::socket::{connect_to, Connect, Socket};
use anyhow::{Context as _, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use bmuster_protocol::session::{
    open_ticket, session_socket_path, SessionEvent, SessionPurpose, SessionTicket, TicketError,
};
use ed25519_dalek::VerifyingKey;
use pump::Ended;
use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use tungstenite::Message;

/// The most sessions running at once on this machine.
const MAX_SESSIONS: usize = 32;

/// Starts sessions for the live socket. Cheap to clone.
#[derive(Clone)]
pub struct Sessions {
    inner: Arc<Inner>,
}

struct Inner {
    session: Arc<Session>,
    server_key: VerifyingKey,
    /// Session ids already started, until their ticket expires: a ticket
    /// works once.
    seen: Mutex<HashMap<String, i64>>,
    running: Mutex<usize>,
    stop: Arc<AtomicBool>,
}

/// A `session-open` the agent would not start.
#[derive(Debug)]
pub struct Refused {
    /// The session id, if the ticket could be read at all.
    pub session_id: Option<String>,
    pub message: String,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The session id of a ticket that failed its checks, for the refusal
/// message only (never trusted for anything else).
fn claimed_session_id(ticket_base64: &str) -> Option<String> {
    let json = BASE64.decode(ticket_base64).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&json).ok()?;
    Some(value.get("sessionId")?.as_str()?.to_string())
}

impl Sessions {
    pub fn new(session: Arc<Session>, server_key: VerifyingKey, stop: Arc<AtomicBool>) -> Self {
        Self {
            inner: Arc::new(Inner {
                session,
                server_key,
                seen: Mutex::new(HashMap::new()),
                running: Mutex::new(0),
                stop,
            }),
        }
    }

    /// Checks a ticket and remembers it, so it cannot be used twice.
    fn admit(&self, ticket: &str, signature: &str) -> Result<SessionTicket, TicketError> {
        let now = self.inner.session.server_now_ms();
        let ticket = open_ticket(
            &self.inner.server_key,
            ticket,
            signature,
            &self.inner.session.machine_id,
            now,
        )?;
        let mut seen = lock(&self.inner.seen);
        seen.retain(|_, expires| {
            *expires + 2 * bmuster_protocol::session::TICKET_CLOCK_GRACE_MS > now
        });
        if seen.contains_key(&ticket.session_id) {
            return Err(TicketError::Replayed);
        }
        seen.insert(ticket.session_id.clone(), ticket.expires_at_ms);
        Ok(ticket)
    }

    /// `session-open` from the live socket: starts the session on its own
    /// thread, or says why not.
    pub fn open(&self, ticket: &str, signature: &str) -> Result<(), Refused> {
        let admitted = self.admit(ticket, signature).map_err(|e| Refused {
            session_id: claimed_session_id(ticket),
            message: format!("The agent refused the session: {e}."),
        })?;
        {
            let mut running = lock(&self.inner.running);
            if *running >= MAX_SESSIONS {
                return Err(Refused {
                    session_id: Some(admitted.session_id),
                    message: format!("This machine already has {MAX_SESSIONS} sessions open."),
                });
            }
            *running += 1;
        }
        let inner = Arc::clone(&self.inner);
        let session_id = admitted.session_id.clone();
        let started = std::thread::Builder::new()
            .name(format!(
                "session-{}",
                session_id.chars().take(8).collect::<String>()
            ))
            .spawn(move || {
                log::info!(
                    "Session {} for {} ({}) started.",
                    admitted.session_id,
                    admitted.user.name,
                    purpose_label(&admitted.purpose)
                );
                match serve(&inner, &admitted) {
                    Ok(ended) => log::info!("Session {} ended: {ended:?}.", admitted.session_id),
                    Err(e) => log::warn!("Session {} failed: {e:#}", admitted.session_id),
                }
                *lock(&inner.running) -= 1;
            });
        if let Err(e) = started {
            *lock(&self.inner.running) -= 1;
            return Err(Refused {
                session_id: Some(session_id),
                message: format!("The agent could not start a thread for the session: {e}."),
            });
        }
        Ok(())
    }
}

fn purpose_label(purpose: &SessionPurpose) -> String {
    match purpose {
        SessionPurpose::Terminal { shell, .. } => format!("terminal, {}", shell.as_str()),
        SessionPurpose::Exec { shell, .. } => format!("command, {}", shell.as_str()),
    }
}

/// Opens the session's socket and runs the session on it.
fn serve(inner: &Inner, ticket: &SessionTicket) -> Result<Ended> {
    let path = session_socket_path(&ticket.session_id);
    let mut socket = match connect_to(&inner.session, &path)? {
        Connect::Open(socket) => *socket,
        Connect::Revoked(message) => {
            anyhow::bail!("the server refused the session socket: {message}")
        }
    };
    match &ticket.purpose {
        SessionPurpose::Terminal { shell, cols, rows } => {
            let request = terminal::Request {
                shell: *shell,
                size: PtySize::clamped(*cols, *rows),
                console_user: &ticket.user.name,
            };
            match terminal::start(&request) {
                Ok(spawned) => terminal::run(&mut socket, spawned, &inner.stop),
                Err(e) => fail(&mut socket, &e),
            }
        }
        SessionPurpose::Exec {
            shell,
            command,
            timeout_ms,
            max_output_bytes,
        } => {
            let request = exec::Request {
                shell: *shell,
                command,
                limits: Limits::clamped(*timeout_ms, *max_output_bytes),
                console_user: &ticket.user.name,
            };
            match exec::prepare(&request) {
                Ok(launch) => exec::run(&mut socket, launch, request.limits, &inner.stop),
                Err(e) => fail(&mut socket, &e),
            }
        }
    }
}

/// Tells the console why the session could not start, then closes.
fn fail(socket: &mut Socket, error: &anyhow::Error) -> Result<Ended> {
    let event = SessionEvent::Failed {
        message: format!("{error:#}"),
    };
    socket
        .send(Message::text(serde_json::to_string(&event)?))
        .context("could not report the failure")?;
    let _ = socket.close(None);
    let _ = socket.flush();
    Ok(Ended::Finished)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::{Security, ServerUrl, TlsMode, Transport};
    use bmuster_protocol::session::ticket_message;
    use bmuster_protocol::ServerTrust;
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    fn sessions(server: &SigningKey) -> Sessions {
        let transport = Transport::new(
            ServerUrl::parse("https://example.com").unwrap(),
            Security::once(TlsMode::Checked(ServerTrust::Public)),
        );
        let session = Session::new(
            transport,
            "machine-1".into(),
            SigningKey::from_bytes(&[1; 32]),
        );
        Sessions::new(
            Arc::new(session),
            server.verifying_key(),
            Arc::new(AtomicBool::new(false)),
        )
    }

    fn ticket(server: &SigningKey, session_id: &str, now: i64) -> (String, String) {
        let json = serde_json::to_vec(&json!({
            "sessionId": session_id,
            "machineId": "machine-1",
            "user": { "id": "u1", "name": "Jack" },
            "permissions": ["view", "terminal"],
            "runAs": { "kind": "admin" },
            "issuedAtMs": now,
            "expiresAtMs": now + 60_000,
            "purpose": { "kind": "terminal", "shell": "sh", "cols": 80, "rows": 24 }
        }))
        .unwrap();
        let signature = server.sign(&ticket_message(&json));
        (BASE64.encode(json), BASE64.encode(signature.to_bytes()))
    }

    #[test]
    fn a_ticket_is_admitted_once() {
        let server = SigningKey::from_bytes(&[5; 32]);
        let sessions = sessions(&server);
        let now = sessions.inner.session.server_now_ms();
        let (text, signature) = ticket(&server, "s-1", now);
        assert!(sessions.admit(&text, &signature).is_ok());
        assert_eq!(
            sessions.admit(&text, &signature),
            Err(TicketError::Replayed)
        );
        let (other, other_signature) = ticket(&server, "s-2", now);
        assert!(sessions.admit(&other, &other_signature).is_ok());
    }

    #[test]
    fn a_refusal_names_the_session_it_could_read() {
        let server = SigningKey::from_bytes(&[5; 32]);
        let impostor = SigningKey::from_bytes(&[6; 32]);
        let sessions = sessions(&server);
        let now = sessions.inner.session.server_now_ms();
        let (text, signature) = ticket(&impostor, "s-3", now);
        let refused = sessions.open(&text, &signature).unwrap_err();
        assert_eq!(refused.session_id.as_deref(), Some("s-3"));
        assert!(
            refused
                .message
                .contains("not signed by this agent's server"),
            "{}",
            refused.message
        );
        assert_eq!(*lock(&sessions.inner.running), 0);
    }
}
