//! Remote sessions (SPEC-SESSIONS): the server asks on the live socket with
//! a signed ticket; the agent checks it, opens the session's own socket and
//! runs what the ticket is for on its own thread, so a busy session never
//! blocks the live socket.
//!
//! Every session kind shares this path: [`Sessions::open`] checks the
//! ticket, [`pump`] moves the bytes, and the kind's module (terminal, exec,
//! files, desktop) decides what the bytes mean.

mod desktop;
mod exec;
mod files;
#[cfg(target_os = "linux")]
pub mod files_helper;
pub mod live;
mod pump;
mod readiness;
mod terminal;
#[cfg(test)]
mod testing;
#[cfg(windows)]
pub mod windows_desktop;

use crate::client::Session;
use crate::exec::pipe::Limits;
use crate::exec::placement::{Kind, Placement, SessionMode};
use crate::exec::PtySize;
use crate::logging::SHIP;
use crate::socket::{connect_to, Connect, Socket};
use crate::timeline::Timeline;
use anyhow::{Context as _, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use bmuster_protocol::checks::TimelineOutcome;
use bmuster_protocol::session::{
    open_ticket, session_socket_path, SessionEvent, SessionPurpose, SessionTicket, TicketError,
};
use ed25519_dalek::VerifyingKey;
use live::Live;
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
    data_dir: std::path::PathBuf,
    session: Arc<Session>,
    server_key: VerifyingKey,
    /// Session ids already started, until their ticket expires: a ticket
    /// works once.
    seen: Mutex<HashMap<String, i64>>,
    running: Mutex<usize>,
    stop: Arc<AtomicBool>,
    /// Where terminal, exec and files sessions run.
    mode: SessionMode,
    /// Who is connected, for the local page.
    live: Arc<Live>,
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
    pub fn new(
        session: Arc<Session>,
        server_key: VerifyingKey,
        stop: Arc<AtomicBool>,
        mode: SessionMode,
        data_dir: std::path::PathBuf,
        live: Arc<Live>,
    ) -> Self {
        log::info!("{}", mode.describe());
        mode.sweep();
        Self {
            inner: Arc::new(Inner {
                data_dir,
                session,
                server_key,
                seen: Mutex::new(HashMap::new()),
                running: Mutex::new(0),
                stop,
                mode,
                live,
            }),
        }
    }

    /// How many sessions run now.
    #[cfg(target_os = "linux")]
    pub fn running(&self) -> usize {
        *lock(&self.inner.running)
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
        let text = TicketText {
            ticket: ticket.to_string(),
            signature: signature.to_string(),
        };
        let started = std::thread::Builder::new()
            .name(format!(
                "session-{}",
                session_id.chars().take(8).collect::<String>()
            ))
            .spawn(move || {
                // No idle sleep while this session runs (SPEC-DESKTOP-WAKE);
                // let go when the thread ends, however it ends.
                let _awake = crate::power::sessions::hold();
                // Listed for the local page until the thread ends.
                let _listed =
                    inner
                        .live
                        .enter(&admitted.session_id, &admitted.purpose, &admitted.user.name);
                let label = purpose_label(&admitted.purpose);
                log::info!(
                    "Session {} for {} ({label}) started.",
                    admitted.session_id,
                    admitted.user.name,
                );
                let timeline = Timeline::new(&admitted.session_id, purpose_kind(&admitted.purpose));
                let _entered = crate::timeline::enter(&timeline);
                timeline.step("ticket-checked", &label);
                match serve(&inner, &admitted, &text) {
                    Ok(ended) => {
                        log::info!("Session {} ended: {ended:?}.", admitted.session_id);
                        timeline.ship(&SHIP, TimelineOutcome::Ended, &format!("{ended:?}"));
                    }
                    Err(e) => {
                        log::warn!("Session {} failed: {e:#}", admitted.session_id);
                        timeline.ship(&SHIP, TimelineOutcome::Failed, &format!("{e:#}"));
                        failed_to_start(&admitted.purpose);
                    }
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

/// The timeline's name for the session's kind.
fn purpose_kind(purpose: &SessionPurpose) -> &'static str {
    match purpose {
        SessionPurpose::Terminal { .. } => "terminal",
        SessionPurpose::Exec { .. } => "exec",
        SessionPurpose::Files {} => "files",
        SessionPurpose::Desktop { .. } => "desktop",
    }
}

fn purpose_label(purpose: &SessionPurpose) -> String {
    match purpose {
        SessionPurpose::Terminal { shell, .. } => format!("terminal, {}", shell.as_str()),
        SessionPurpose::Exec { shell, .. } => format!("command, {}", shell.as_str()),
        SessionPurpose::Files {} => "files".into(),
        SessionPurpose::Desktop { .. } => "desktop".into(),
    }
}

/// A ticket as the server sent it: the Windows desktop helper checks it
/// again itself.
#[cfg_attr(not(windows), allow(dead_code))]
struct TicketText {
    ticket: String,
    signature: String,
}

/// Opens the session's socket and runs the session on it.
fn serve(inner: &Inner, ticket: &SessionTicket, text: &TicketText) -> Result<Ended> {
    // The tray shows who is connected while a desktop session with the
    // notice runs, on every platform (SPEC-DESKTOP 8.2).
    let _viewer = match ticket.purpose {
        SessionPurpose::Desktop { notice: true, .. } => {
            Some(crate::tray::viewers::add(&ticket.user.name))
        }
        _ => None,
    };
    // Windows: session 0 has no screen; the helper in the console session
    // opens the socket and runs the session (SPEC-DESKTOP 6.2).
    #[cfg(windows)]
    if let SessionPurpose::Desktop { .. } = ticket.purpose {
        return windows_desktop::serve(inner, ticket, text);
    }
    #[cfg(not(windows))]
    let _ = text;
    let path = session_socket_path(&ticket.session_id);
    let mut socket = match connect_to(&inner.session, &path)? {
        Connect::Open(socket) => *socket,
        Connect::Revoked(message) => {
            anyhow::bail!("the server refused the session socket: {message}")
        }
    };
    crate::timeline::step("socket-open", "");
    let placement = |kind: Kind| {
        let placement = inner.mode.placement(kind, &ticket.session_id);
        if let Ok(placement) = &placement {
            crate::timeline::step("placement", &placement.describe());
        }
        placement
    };
    match &ticket.purpose {
        SessionPurpose::Terminal { shell, cols, rows } => {
            let request = terminal::Request {
                shell: *shell,
                size: PtySize::clamped(*cols, *rows),
                console_user: &ticket.user.name,
            };
            match placement(Kind::Terminal)
                .and_then(|placement| terminal::start(&request, placement))
            {
                Ok(spawned) => {
                    crate::timeline::step("started", request.shell.as_str());
                    terminal::run(&mut socket, spawned, &inner.stop)
                }
                Err(e) => {
                    failed_to_start(&ticket.purpose);
                    fail(&mut socket, &e)
                }
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
            match placement(Kind::Exec)
                .and_then(|placement| Ok((exec::prepare(&request)?, placement)))
            {
                Ok((launch, placement)) => {
                    exec::run(&mut socket, launch, placement, request.limits, &inner.stop)
                }
                Err(e) => fail(&mut socket, &e),
            }
        }
        SessionPurpose::Files {} => match placement(Kind::Files) {
            Ok(Placement::InProcess) => {
                files::run(&mut socket, &inner.stop, inner.data_dir.clone())
            }
            #[cfg(target_os = "linux")]
            Ok(Placement::Unit(unit)) => {
                match files_helper::start(&unit, &inner.stop, &inner.data_dir) {
                    Ok(started) => {
                        crate::timeline::step("started", "files helper");
                        files_helper::relay(&mut socket, &unit, started, &inner.stop)
                    }
                    Err(e) => {
                        failed_to_start(&ticket.purpose);
                        fail(&mut socket, &e)
                    }
                }
            }
            Err(e) => {
                failed_to_start(&ticket.purpose);
                fail(&mut socket, &e)
            }
        },
        SessionPurpose::Desktop { consent, notice } => {
            let request = desktop::Request {
                permissions: &ticket.permissions,
                consent: *consent,
                notice: *notice,
            };
            #[cfg(target_os = "linux")]
            let open = || {
                let mode = bmuster_desktop::Mode::from_permissions(&ticket.permissions)?;
                Ok(bmuster_desktop::Console::Following(Box::new(
                    crate::wayland::Watch::new(&inner.data_dir, mode),
                )))
            };
            #[cfg(not(target_os = "linux"))]
            let open = bmuster_desktop::open_console;
            match desktop::prepare(&request, open) {
                Ok(desktop::Prepared::Ready(ready)) => {
                    crate::timeline::step("screen-opened", "");
                    desktop::run(&mut socket, *ready, &ticket.user.name, &inner.stop)
                }
                Ok(desktop::Prepared::Busy) => desktop::refuse_busy(&mut socket),
                Err(e) => {
                    failed_to_start(&ticket.purpose);
                    fail(&mut socket, &e)
                }
            }
        }
    }
}

/// A terminal, files or desktop session did not start: ship the fixed
/// journal query (SPEC-AGENT-LOGS 1). Commands are left out: their units can
/// hold command text.
fn failed_to_start(purpose: &SessionPurpose) {
    match purpose {
        SessionPurpose::Terminal { .. } => crate::diagnostics::session_failed("terminal"),
        SessionPurpose::Files {} => crate::diagnostics::session_failed("files"),
        SessionPurpose::Desktop { .. } => crate::diagnostics::session_failed("desktop"),
        SessionPurpose::Exec { .. } => {}
    }
}

/// Tells the console why the session could not start, then closes. The
/// session's timeline ships now, before the journal query and the checks.
fn fail(socket: &mut Socket, error: &anyhow::Error) -> Result<Ended> {
    let message = format!("{error:#}");
    crate::timeline::failed(&message);
    let event = SessionEvent::Failed { message };
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
            SessionMode::InProcess,
            std::env::temp_dir(),
            Arc::new(Live::default()),
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

    /// SPEC-DIAGNOSTICS D7: steps with times, shipped once, at the end or
    /// at once on failure, within the record's size.
    #[test]
    fn timeline_records_steps() {
        use crate::logging::ShipQueue;
        use crate::timeline::{Timeline, MAX_STEPS};
        use bmuster_desktop::Outgoing;
        use bmuster_protocol::checks::{SessionTimeline, TIMELINE_TARGET};

        let queue: &'static ShipQueue = Box::leak(Box::new(ShipQueue::new()));
        queue.enable();
        let timeline = Timeline::new("s-9", "desktop");
        {
            let _entered = crate::timeline::enter(&timeline);
            crate::timeline::step("ticket-checked", "desktop");
            // Steps on another thread of the session, once it enters too.
            let shared = std::sync::Arc::clone(&timeline);
            std::thread::spawn(move || {
                let _entered = crate::timeline::enter(&shared);
                crate::timeline::step("helper-started", "bmuster-console-1-1 password=x");
            })
            .join()
            .unwrap();
        }
        crate::timeline::step("outside", "no session: nothing happens");
        let mut seen = desktop::Seen::default();
        for message in [
            Outgoing::Text(
                r#"{"type":"displays","list":[{"id":"a"},{"id":"b"}],"current":"a"}"#.into(),
            ),
            Outgoing::Binary(vec![0; 300]),
            Outgoing::Binary(vec![0; 300]),
            Outgoing::Text(r#"{"type":"state","screen":{"kind":"sign-in"}}"#.into()),
            Outgoing::Text(r#"{"type":"state","screen":{"kind":"sign-in"}}"#.into()),
            Outgoing::Text(
                r#"{"type":"displays","list":[{"id":"a"},{"id":"b"}],"current":"b"}"#.into(),
            ),
            Outgoing::Text(r#"{"type":"error","code":"capture-failed","message":"lost"}"#.into()),
        ] {
            seen.observe(&timeline, &message);
        }
        timeline.ship(queue, TimelineOutcome::Failed, "Cannot open the screen");
        timeline.ship(queue, TimelineOutcome::Ended, "Finished");
        let (records, _) = queue.take();
        let shipped: Vec<_> = records
            .iter()
            .filter(|r| r.target == TIMELINE_TARGET)
            .collect();
        assert_eq!(shipped.len(), 1, "a failure ships at once, and only once");
        let parsed: SessionTimeline = serde_json::from_str(&shipped[0].text).unwrap();
        assert_eq!(parsed.session_id, "s-9");
        assert_eq!(parsed.outcome, TimelineOutcome::Failed);
        let steps: Vec<&str> = parsed.steps.iter().map(|s| s.step.as_str()).collect();
        assert_eq!(
            steps,
            [
                "ticket-checked",
                "helper-started",
                "screens",
                "first-frame",
                "screen-state",
                "screen-switch",
                "error",
                "failed"
            ]
        );
        assert_eq!(parsed.steps[1].detail, "[redacted diagnostic line]");
        assert_eq!(parsed.steps[2].detail, "2 found, showing a");
        assert_eq!(parsed.steps[5].detail, "a to b (2 screens)");
        assert!(parsed.steps.windows(2).all(|pair| pair[0].t <= pair[1].t));

        // A long session keeps its first and last steps.
        let long = Timeline::new("s-10", "terminal");
        for n in 0..(MAX_STEPS + 25) {
            long.step("resize", &format!("step {n} {}", "x".repeat(200)));
        }
        long.ship(queue, TimelineOutcome::Ended, "ServerClosed");
        let (records, _) = queue.take();
        let text = &records[0].text;
        assert!(text.len() <= bmuster_protocol::logs::MAX_RECORD_TEXT_BYTES);
        let parsed: SessionTimeline = serde_json::from_str(text).unwrap();
        assert!(parsed.omitted >= 25, "{}", parsed.omitted);
        assert!(parsed.steps[0].detail.starts_with("step 0 "));
        assert_eq!(parsed.steps.last().map(|s| s.step.as_str()), Some("ended"));
    }

    /// SPEC-DIAGNOSTICS D7: a desktop session's figures every interval.
    #[cfg(target_os = "linux")]
    #[test]
    fn desktop_stats_interval() {
        use bmuster_desktop::session::{FiguresReport, FIGURES_EVERY};
        use bmuster_desktop::{Console, DesktopSession, Incoming, Mode};
        use bmuster_protocol::checks::STATS_EVERY_MS;
        use std::time::{Duration, Instant};

        assert_eq!(FIGURES_EVERY, Duration::from_millis(STATS_EVERY_MS));
        let Ok(Console::Fixed(platform)) = desktop::tests::still_platform() else {
            panic!("a fixed test screen");
        };
        let mut session = DesktopSession::new(
            Mode::Watch,
            platform.capturer,
            platform.make_input,
            Instant::now(),
        )
        .unwrap();
        let (sender, incoming) = std::sync::mpsc::channel();
        sender
            .send(Incoming::Text(
                r#"{"type":"hello","codecs":["jpeg"],"viewport":{"width":800,"height":600,"pixelRatio":1}}"#.into(),
            ))
            .unwrap();
        let ender = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(450));
            let _ = sender.send(Incoming::End(bmuster_desktop::EndReason::Closed));
        });
        let mut reports: Vec<FiguresReport> = Vec::new();
        let stop = std::sync::atomic::AtomicBool::new(false);
        bmuster_desktop::run(
            &mut session,
            &incoming,
            &mut |_| Ok(()),
            &stop,
            Duration::from_millis(100),
            &mut |report| reports.push(report),
        );
        ender.join().unwrap();
        assert_eq!(reports[0].backend, "test", "the capture path at once");
        assert!(reports.len() >= 3, "every interval: {}", reports.len());
        assert!(reports[1..]
            .iter()
            .all(|r| r.interval >= Duration::from_millis(100)));
        let sent: u64 = reports.iter().map(|r| r.figures.frames_sent).sum();
        assert!(sent >= 1, "the keyframe was counted");
        let busy = reports.iter().find(|r| r.figures.frames_sent > 0).unwrap();
        let stats = desktop::stats_of("s-11", busy);
        assert_eq!(stats.session_id, "s-11");
        assert_eq!(stats.backend, "test");
        assert!(stats.bytes_per_second > 0);
        assert!(stats.tiles > 0);
        assert_eq!(
            serde_json::to_value(&stats).unwrap()["framesSent"],
            busy.figures.frames_sent
        );
    }
}
