//! `bmuster-agent desktop-helper` (SPEC-DESKTOP 6.2): runs as SYSTEM in the
//! console session, started by the service, and carries every desktop
//! session there.
//!
//! It opens the service's pipes (checking the service's process id),
//! reads each session's ticket from them and checks it again with the
//! server key from the data folder: signature, machine, permission, and the
//! time window as of when the service admitted it. It then opens the
//! session's socket itself, signed with the agent key (readable by SYSTEM),
//! on the service's corrected clock, and runs the same desktop session as
//! Linux, following the input desktop. Video never crosses the pipe.

use super::super::desktop;
use super::super::fail;
use crate::client::Session;
use crate::identity;
use crate::socket::{connect_to, Connect, Socket};
use crate::worker;
use anyhow::{anyhow, Context as _, Result};
use bmuster_desktop::winsession::handoff::{read_message, write_message, FromHelper, ToHelper};
use bmuster_desktop::winsession::{console, pipe, prepare_helper_process};
use bmuster_protocol::decode_public_key;
use bmuster_protocol::session::{open_ticket, session_socket_path, SessionPurpose, SessionTicket};
use ed25519_dalek::VerifyingKey;
use std::collections::HashMap;
use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const PIPE_TIMEOUT: Duration = Duration::from_secs(10);
/// The signed upgrade is tried this often: the service signs requests too,
/// and a timestamp equal to its last one is refused as a replay.
const CONNECT_ATTEMPTS: u32 = 3;
const RETRY_AFTER: Duration = Duration::from_millis(300);
/// After `quit`, sessions get this long to say `ended` and let go.
const QUIT_WITHIN: Duration = Duration::from_secs(3);

/// The helper's command line.
pub struct Args {
    pub pipe: String,
    pub service_pid: u32,
    pub data_dir: PathBuf,
    pub insecure_dev_tls: bool,
}

type Writer = Arc<Mutex<File>>;

fn tell(writer: &Writer, message: &FromHelper) -> std::io::Result<()> {
    let mut file = writer
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    write_message(&mut *file, message)
}

fn tell_or_log(writer: &Writer, message: &FromHelper) {
    if let Err(error) = tell(writer, message) {
        log::warn!("Could not tell the service {message:?}: {error}");
    }
}

/// What every session thread shares.
struct Shared {
    writer: Writer,
    server_key: VerifyingKey,
    session: Session,
}

struct Running {
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

/// Runs until the service says `quit` or goes away.
pub fn run(args: &Args) -> Result<()> {
    prepare_helper_process();
    let end = pipe::connect(&args.pipe, Some(args.service_pid), PIPE_TIMEOUT)
        .map_err(|e| anyhow!("{e}"))
        .context("could not open the service's pipe")?;
    let writer: Writer = Arc::new(Mutex::new(end.writer));
    let mut reader = end.reader;
    tell(
        &writer,
        &FromHelper::Hello {
            process_id: std::process::id(),
            console_session: console::current_session().unwrap_or(u32::MAX),
        },
    )?;
    {
        let writer = Arc::clone(&writer);
        bmuster_desktop::input::windows::set_secure_attention(Box::new(move || {
            tell(&writer, &FromHelper::SecureAttention).map_err(|e| e.to_string())
        }));
    }
    let identity = identity::load(&args.data_dir)?;
    let shared = Arc::new(Shared {
        writer: Arc::clone(&writer),
        server_key: decode_public_key(&identity.server_public_key)
            .context("identity.json holds an unreadable server key")?,
        session: worker::open_session(&args.data_dir, args.insecure_dev_tls)?,
    });

    let mut running: HashMap<String, Running> = HashMap::new();
    loop {
        running.retain(|_, session| !session.thread.is_finished());
        match read_message::<ToHelper>(&mut reader) {
            Ok(Some(ToHelper::Start {
                session_id,
                ticket,
                signature,
                admitted_at_ms,
                clock_offset_ms,
                resume,
            })) => {
                if running.contains_key(&session_id) {
                    log::warn!("Desktop session {session_id} is already running here");
                    continue;
                }
                shared.session.adopt_clock_offset_ms(clock_offset_ms);
                let start = Start {
                    session_id: session_id.clone(),
                    ticket,
                    signature,
                    admitted_at_ms,
                    resume,
                };
                let stop = Arc::new(AtomicBool::new(false));
                let thread = {
                    let shared = Arc::clone(&shared);
                    let stop = Arc::clone(&stop);
                    std::thread::Builder::new()
                        .name(format!(
                            "session-{}",
                            session_id.chars().take(8).collect::<String>()
                        ))
                        .spawn(move || serve(&shared, start, &stop))
                };
                match thread {
                    Ok(thread) => {
                        running.insert(session_id, Running { stop, thread });
                    }
                    Err(error) => tell_or_log(
                        &writer,
                        &FromHelper::Failed {
                            session_id,
                            message: format!(
                                "The desktop helper could not start a thread: {error}"
                            ),
                        },
                    ),
                }
            }
            Ok(Some(ToHelper::Stop { session_id })) => {
                if let Some(session) = running.get(&session_id) {
                    session.stop.store(true, Ordering::SeqCst);
                }
            }
            Ok(Some(ToHelper::Quit)) => {
                log::info!("The service asked the desktop helper to quit");
                break;
            }
            Ok(None) => {
                log::info!("The service closed the desktop helper's pipe");
                break;
            }
            Err(error) => {
                log::error!("The service's pipe broke: {error}");
                break;
            }
        }
    }
    for session in running.values() {
        session.stop.store(true, Ordering::SeqCst);
    }
    let deadline = Instant::now() + QUIT_WITHIN;
    while running.values().any(|s| !s.thread.is_finished()) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

struct Start {
    session_id: String,
    ticket: String,
    signature: String,
    admitted_at_ms: i64,
    resume: bool,
}

/// Checks the ticket again: signed by this agent's server, for this machine,
/// a desktop session, and within its time window when the service admitted
/// it.
fn check(shared: &Shared, start: &Start) -> Result<SessionTicket, String> {
    let ticket = open_ticket(
        &shared.server_key,
        &start.ticket,
        &start.signature,
        &shared.session.machine_id,
        start.admitted_at_ms,
    )
    .map_err(|e| format!("The desktop helper refused the session: {e}."))?;
    if ticket.session_id != start.session_id {
        return Err("The desktop helper was handed a ticket for another session.".into());
    }
    if !matches!(ticket.purpose, SessionPurpose::Desktop { .. }) {
        return Err("The desktop helper was handed a ticket that is not for a desktop.".into());
    }
    Ok(ticket)
}

fn open_socket(session: &Session, session_id: &str) -> Result<Socket> {
    let path = session_socket_path(session_id);
    let mut attempt = 1;
    loop {
        match connect_to(session, &path) {
            Ok(Connect::Open(socket)) => return Ok(*socket),
            Ok(Connect::Revoked(message)) => {
                anyhow::bail!("the server refused the session socket: {message}")
            }
            Err(error) if attempt < CONNECT_ATTEMPTS => {
                log::warn!("Session socket attempt {attempt} failed: {error:#}");
                attempt += 1;
                std::thread::sleep(RETRY_AFTER);
            }
            Err(error) => return Err(error),
        }
    }
}

fn serve(shared: &Shared, start: Start, stop: &Arc<AtomicBool>) {
    let session_id = start.session_id.clone();
    // The helper's own steps (screens, capture path, figures) go to its log
    // as `[session-timeline]` and `[session-stats]` lines, which the service
    // ships (SPEC-DIAGNOSTICS 3, 4).
    let timeline = crate::timeline::Timeline::new(&session_id, "desktop-helper");
    let _entered = crate::timeline::enter(&timeline);
    timeline.step(
        "helper",
        if start.resume {
            "moved to this console session"
        } else {
            "started in the console session"
        },
    );
    let opened = check(shared, &start).and_then(|ticket| {
        open_socket(&shared.session, &session_id)
            .map(|socket| (ticket, socket))
            .map_err(|e| format!("The desktop helper could not open the session: {e:#}"))
    });
    let (ticket, mut socket) = match opened {
        Ok(opened) => opened,
        Err(message) => {
            log::warn!("Desktop session {session_id}: {message}");
            timeline.ship(
                &crate::logging::SHIP,
                bmuster_protocol::checks::TimelineOutcome::Failed,
                &message,
            );
            tell_or_log(
                &shared.writer,
                &FromHelper::Failed {
                    session_id,
                    message,
                },
            );
            return;
        }
    };
    tell_or_log(
        &shared.writer,
        &FromHelper::Attached {
            session_id: session_id.clone(),
        },
    );
    log::info!(
        "Desktop session {session_id} for {} {}",
        ticket.user.name,
        if start.resume {
            "moved to this console session"
        } else {
            "started"
        }
    );
    let SessionPurpose::Desktop { consent, notice } = ticket.purpose else {
        return;
    };
    let request = desktop::Request {
        permissions: &ticket.permissions,
        consent,
        notice,
    };
    let ended = match desktop::prepare(&request, bmuster_desktop::open_console) {
        Ok(desktop::Prepared::Ready(ready)) => {
            desktop::run(&mut socket, *ready, &ticket.user.name, stop)
        }
        Ok(desktop::Prepared::Busy) => desktop::refuse_busy(&mut socket),
        Err(error) => fail(&mut socket, &error),
    };
    let (outcome, reason) = match ended {
        Ok(ended) => (
            bmuster_protocol::checks::TimelineOutcome::Ended,
            format!("{ended:?}"),
        ),
        Err(error) => (
            bmuster_protocol::checks::TimelineOutcome::Failed,
            format!("{error:#}"),
        ),
    };
    timeline.ship(&crate::logging::SHIP, outcome, &reason);
    tell_or_log(&shared.writer, &FromHelper::Ended { session_id, reason });
}
