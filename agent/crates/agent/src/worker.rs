//! `bmuster-agent run`: the check-in loop on this thread, the live socket on
//! its own thread, and the local page on its own threads.

use crate::client::{Reply, Security, ServerUrl, Session, Transport};
use crate::exec::placement::SessionMode;
use crate::identity;
use crate::inventory::{self, Probe};
use crate::local_page::journal::Journal;
use crate::local_page::people::People;
use crate::local_page::{self, Reporter};
use crate::log_spool::{Shipper, Spool, SPOOL_DIR};
use crate::sessions::Sessions;
use crate::socket;
use crate::status::{RunMode, StatusBoard};
use crate::trust::{Trust, TrustState};
use crate::updates::{Considered, WorkerUpdates};
use anyhow::{Context as _, Result};
use bmuster_protocol::{
    decode_public_key, CheckInReply, CheckInRequest, InventoryReport, Refusal, RefusalReason,
    UpdateReport, CHECK_IN_PATH,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// After the server would not take local page events (an older server), wait
/// this long before offering them again.
const EVENTS_RETRY: Duration = Duration::from_secs(3600);

/// Messages to the check-in loop.
pub enum Signal {
    CheckInNow,
    Revoked(String),
    /// The service manager asked the agent to stop (Windows), or the local
    /// page uninstalled a development copy.
    Stop,
    /// The local page asked for a restart (also after moving servers).
    Restart,
}

/// How `run` ended without an error.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Stopped,
    Revoked,
    /// Start again: the service manager does it for a service; `main`
    /// starts a new copy for a development run.
    Restart,
    /// A newer build is checked and waiting in `versions/incoming`: the
    /// launcher switches to it (SPEC-AGENT-UPDATES).
    Update,
}

/// Doubling wait between failed attempts.
pub struct Backoff {
    first: Duration,
    max: Duration,
    next: Duration,
}

impl Backoff {
    pub fn new(first: Duration, max: Duration) -> Self {
        Self {
            first,
            max,
            next: first,
        }
    }

    pub fn reset(&mut self) {
        self.next = self.first;
    }

    pub fn next_wait(&mut self) -> Duration {
        let wait = self.next;
        self.next = (self.next * 2).min(self.max);
        wait
    }
}

pub struct RunOptions {
    pub data_dir: PathBuf,
    /// `--insecure-dev-tls`: any certificate. Otherwise the certificate is
    /// checked as identity.json says (trust store or pinned key).
    pub insecure_dev_tls: bool,
    pub mode: RunMode,
    /// `--local-page-port`: the local page on this loopback port instead of
    /// what local-page.json or the default says (tests and development).
    pub local_page_port: Option<u16>,
    /// Started by the launcher (`run --launched`), which can switch versions.
    pub launched: bool,
    /// `--sessions`: where terminal, exec and files sessions run.
    pub sessions: SessionMode,
}

/// A signed connection to the server this data folder is enrolled with. The
/// certificate check follows identity.json (and saves planned changes to it)
/// unless `insecure_dev_tls`.
pub fn open_session(data_dir: &Path, insecure_dev_tls: bool) -> Result<Session> {
    let identity = identity::load(data_dir)?;
    let key = identity::load_key(data_dir)?;
    let server = ServerUrl::parse(&identity.server_url)?;
    let security = if insecure_dev_tls {
        Security::InsecureDev
    } else {
        let dir = data_dir.to_path_buf();
        Security::Checked(Trust::new(
            TrustState::new(identity.server_trust(), identity.next_pin),
            Box::new(move |state| {
                identity::update(&dir, |saved| {
                    saved.set_server_trust(state.current, state.next);
                })
                .map(|_| ())
            }),
        ))
    };
    Ok(Session::new(
        Transport::new(server, security),
        identity.machine_id,
        key,
    ))
}

/// Runs until revoked or stopped. `signals` is the check-in loop's inbox; its
/// sender is shared with the socket thread and (on Windows) the service.
pub fn run(
    options: &RunOptions,
    sender: Sender<Signal>,
    signals: Receiver<Signal>,
) -> Result<Outcome> {
    identity::finish_pending_move(&options.data_dir)?;
    let identity = identity::load(&options.data_dir)?;
    let session = Arc::new(open_session(&options.data_dir, options.insecure_dev_tls)?);
    let server = &session.transport.server;
    log::info!(
        "BMuster agent {} started: machine {}, server {}",
        env!("BMUSTER_VERSION"),
        identity.machine_id,
        server.base()
    );

    let board = Arc::new(StatusBoard::new(identity.check_in_seconds));
    let people = Arc::new(People::load(&options.data_dir));
    let journal = Arc::new(Journal::open(&options.data_dir));
    let mut reporter = local_page::start(local_page::Setup {
        data_dir: options.data_dir.clone(),
        session: Arc::clone(&session),
        signals: sender.clone(),
        board: Arc::clone(&board),
        mode: options.mode,
        insecure_dev_tls: options.insecure_dev_tls,
        port_override: options.local_page_port,
        people: Arc::clone(&people),
        journal: Arc::clone(&journal),
        launched: options.launched,
    });

    // Desktop sessions run in a helper in the console session (SPEC-DESKTOP 6.2).
    #[cfg(windows)]
    crate::sessions::windows_desktop::supervisor::configure(
        crate::sessions::windows_desktop::supervisor::Options {
            data_dir: options.data_dir.clone(),
            insecure_dev_tls: options.insecure_dev_tls,
        },
    );
    // Its log is shipped as source `helper` (SPEC-DIAGNOSTICS 4).
    #[cfg(windows)]
    crate::diagnostics::windows::follow_helper_log(options.data_dir.join("desktop-helper.log"));
    let stop = Arc::new(AtomicBool::new(false));
    let (shipper, flusher) = start_shipping(&options.data_dir, &stop);
    // A minute from now, then every six hours (SPEC-DIAGNOSTICS 1).
    crate::checks::start(crate::checks::Context {
        data_dir: options.data_dir.clone(),
        mode: options.sessions,
    });
    // The saved policy applies before the server is reachable (SPEC-STAY-AWAKE).
    let power = crate::power::start(options.data_dir.clone());
    let server_key = decode_public_key(&identity.server_public_key)
        .context("identity.json holds an unreadable server key")?;
    let sessions = Sessions::new(
        Arc::clone(&session),
        server_key,
        Arc::clone(&stop),
        options.sessions,
        options.data_dir.clone(),
    );
    let socket_thread = {
        let session = Arc::clone(&session);
        let stop = Arc::clone(&stop);
        let board = Arc::clone(&board);
        let shipper = shipper.clone();
        std::thread::Builder::new()
            .name("live-socket".into())
            .spawn(move || {
                socket::run(
                    &session,
                    &sessions,
                    &sender,
                    &stop,
                    &board,
                    shipper.as_deref(),
                )
            })
            .context("could not start the live socket thread")?
    };

    let updates = WorkerUpdates::new(&options.data_dir, options.launched);
    let outcome = check_in_loop(
        &session,
        &options.data_dir,
        identity.check_in_seconds,
        &signals,
        &board,
        reporter.as_mut(),
        &Local {
            people: &people,
            journal: &journal,
            updates: &updates,
        },
    );
    stop.store(true, Ordering::SeqCst);
    crate::power::stop(power);
    if socket_thread.join().is_err() {
        log::error!("the live socket thread failed");
    }
    if flusher.is_some_and(|flusher| flusher.join().is_err()) {
        log::error!("the log spool thread failed");
    }
    outcome
}

/// Turns on log shipping (SPEC-AGENT-LOGS 1): the queue fills, a thread
/// moves it into the spool under `<data>/logs`, and the live socket sends it.
/// A spool that cannot be opened leaves the agent running without shipping,
/// and says so in its own log.
fn start_shipping(
    data_dir: &Path,
    stop: &Arc<AtomicBool>,
) -> (Option<Arc<Shipper>>, Option<std::thread::JoinHandle<()>>) {
    let spool_dir = data_dir.join(SPOOL_DIR);
    // A panic is written into the spool before the process ends, and ships
    // after the restart (SPEC-DIAGNOSTICS 2).
    crate::logging::install_panic_hook(spool_dir.clone());
    let spool = match Spool::open(&spool_dir, crate::logging::instance()) {
        Ok(spool) => spool,
        Err(error) => {
            log::error!("Could not open the log spool; logs are not sent to the server: {error}");
            return (None, None);
        }
    };
    crate::logging::SHIP.enable();
    let shipper = Arc::new(Shipper::new(spool));
    match shipper.start_flusher(&crate::logging::SHIP, Arc::clone(stop)) {
        Ok(flusher) => (Some(shipper), Some(flusher)),
        Err(error) => {
            log::error!("Could not start the log spool thread; logs are not sent: {error}");
            (None, None)
        }
    }
}

/// The local page's list of people and its waiting events, which the
/// check-in loop keeps up to date and sends.
pub struct Local<'a> {
    pub people: &'a People,
    pub journal: &'a Journal,
    /// Signed updates through the launcher (SPEC-AGENT-UPDATES).
    pub updates: &'a WorkerUpdates,
}

pub fn check_in_loop(
    session: &Session,
    data_dir: &Path,
    mut check_in_seconds: u32,
    signals: &Receiver<Signal>,
    board: &StatusBoard,
    mut reporter: Option<&mut Reporter>,
    local: &Local<'_>,
) -> Result<Outcome> {
    let mut probe = Probe::new();
    let mut events_after = Instant::now();
    // The inventory hash the server is known to hold; `None` sends it in full.
    let mut server_hash: Option<String> = None;
    let mut backoff = Backoff::new(Duration::from_secs(5), Duration::from_secs(300));

    loop {
        let wait = match check_in(
            session,
            &mut probe,
            &mut server_hash,
            local.people,
            local.updates.report(),
        ) {
            Ok(Reply::Ok(reply)) => {
                backoff.reset();
                local.updates.checked_in();
                match identity::check_interval(reply.check_in_seconds) {
                    Ok(seconds) if seconds != check_in_seconds => {
                        log::info!("The server set the check-in interval to {seconds} s.");
                        check_in_seconds = seconds;
                        identity::update(data_dir, |saved| saved.check_in_seconds = seconds)?;
                    }
                    Ok(_) => {}
                    Err(e) => log::warn!("Ignoring the new interval: {e:#}"),
                }
                board.checked_in(&reply.machine_name, check_in_seconds);
                if let Some(reporter) = reporter.as_deref_mut() {
                    reporter.after_check_in(session);
                }
                if let Err(e) = local.people.apply(&reply.local_users) {
                    log::warn!("Local page: could not save the list of people: {e:#}");
                }
                if local.journal.pending() && Instant::now() >= events_after {
                    match local.journal.send(session) {
                        Ok(sent) => log::debug!("Sent {sent} local page events."),
                        Err(e) => {
                            log::warn!(
                                "Could not send local page events (an older server does not take them): {e:#}"
                            );
                            events_after = Instant::now() + EVENTS_RETRY;
                        }
                    }
                }
                if local.updates.consider(session, &reply.update) == Considered::Ready {
                    return Ok(Outcome::Update);
                }
                Duration::from_secs(u64::from(check_in_seconds))
            }
            Ok(Reply::Refused(Refusal {
                reason: RefusalReason::Revoked,
                message,
            })) => return Ok(revoked(&message, board, signals)),
            Ok(Reply::Refused(refusal)) => {
                let wait = backoff.next_wait();
                board.failed(format!("{} ({})", refusal.message, refusal.reason));
                log::warn!(
                    "Check-in refused: {} ({}); retrying in {} s",
                    refusal.message,
                    refusal.reason,
                    wait.as_secs()
                );
                wait
            }
            Err(e) => {
                let wait = backoff.next_wait();
                board.failed(format!("{e:#}"));
                log::warn!("Check-in failed: {e:#}; retrying in {} s", wait.as_secs());
                wait
            }
        };

        match signals.recv_timeout(wait) {
            Ok(Signal::CheckInNow) | Err(RecvTimeoutError::Timeout) => {}
            Ok(Signal::Revoked(message)) => return Ok(revoked(&message, board, signals)),
            Ok(Signal::Restart) => {
                log::info!("Restarting.");
                return Ok(Outcome::Restart);
            }
            Ok(Signal::Stop) | Err(RecvTimeoutError::Disconnected) => {
                log::info!("Stopping.");
                return Ok(Outcome::Stopped);
            }
        }
    }
}

/// The server refused this machine. While the agent is leaving on purpose
/// (moving or uninstalling from the local page) that is expected: wait for
/// the local page to say restart or stop instead of stopping as revoked.
fn revoked(message: &str, board: &StatusBoard, signals: &Receiver<Signal>) -> Outcome {
    if !board.is_leaving() {
        log_revoked(message);
        return Outcome::Revoked;
    }
    log::info!("The server no longer accepts this identity, as expected while leaving it.");
    loop {
        match signals.recv() {
            Ok(Signal::Restart) => {
                log::info!("Restarting.");
                return Outcome::Restart;
            }
            Ok(Signal::Stop) | Err(_) => {
                log::info!("Stopping.");
                return Outcome::Stopped;
            }
            Ok(Signal::CheckInNow | Signal::Revoked(_)) => {}
        }
    }
}

fn log_revoked(message: &str) {
    log::error!(
        "This machine was removed from its BMuster server (revoked): {message} \
         The agent has stopped and will not reconnect. \
         Run `bmuster-agent uninstall` to remove it."
    );
}

/// One signed check-in. On success `server_hash` records what the server holds.
pub fn check_in(
    session: &Session,
    probe: &mut Probe,
    server_hash: &mut Option<String>,
    people: &People,
    update: UpdateReport,
) -> Result<Reply<CheckInReply>> {
    let inventory = probe.inventory()?;
    let hash = inventory.hash()?;
    let report = if server_hash.as_deref() == Some(hash.as_str()) {
        InventoryReport::Unchanged { hash: hash.clone() }
    } else {
        InventoryReport::Full {
            hash: hash.clone(),
            data: Box::new(inventory),
        }
    };
    let full = matches!(report, InventoryReport::Full { .. });
    let request = CheckInRequest {
        agent_version: env!("BMUSTER_VERSION").to_string(),
        uptime_seconds: inventory::uptime_seconds(),
        signed_in_user: inventory::signed_in_user(),
        load: probe.load(),
        inventory: report,
        local_users: people.held(),
        update,
        checks: crate::checks::LATEST.report(),
    };
    let body = serde_json::to_vec(&request)?;
    let reply = session.post_signed::<CheckInReply>(CHECK_IN_PATH, &body)?;
    if let Reply::Ok(ok) = &reply {
        log::debug!(
            "Checked in ({} inventory)",
            if full { "full" } else { "unchanged" }
        );
        *server_hash = if ok.inventory_wanted {
            log::info!("The server asked for the full inventory next time.");
            None
        } else {
            Some(hash)
        };
    }
    Ok(reply)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::client::TlsMode;
    use bmuster_protocol::ServerTrust;
    use ed25519_dalek::SigningKey;
    use std::sync::mpsc;

    /// A session with a server that is not there (nothing listens on port 9),
    /// so every check-in fails at once and the loop goes straight to its inbox.
    fn unreachable() -> Session {
        let transport = Transport::new(
            ServerUrl::parse("http://127.0.0.1:9").unwrap(),
            Security::once(TlsMode::Checked(ServerTrust::Public)),
        );
        Session::new(transport, "m".into(), SigningKey::from_bytes(&[1; 32]))
    }

    fn outcome(board: &StatusBoard, inbox: Vec<Signal>) -> Outcome {
        let (sender, signals) = mpsc::channel();
        for signal in inbox {
            sender.send(signal).unwrap();
        }
        let dir = tempfile::tempdir().unwrap();
        let updates = WorkerUpdates::with_keys(dir.path(), false, vec![]);
        let local = Local {
            people: &People::load(dir.path()),
            journal: &Journal::open(dir.path()),
            updates: &updates,
        };
        check_in_loop(
            &unreachable(),
            dir.path(),
            60,
            &signals,
            board,
            None,
            &local,
        )
        .unwrap()
    }

    #[test]
    fn the_local_page_can_restart_the_agent() {
        let board = StatusBoard::new(60);
        assert_eq!(outcome(&board, vec![Signal::Restart]), Outcome::Restart);
        assert!(
            board.snapshot().last_error.is_some(),
            "the failed check-in is on the board"
        );
    }

    #[test]
    fn revoked_stops_the_agent_unless_it_is_leaving_on_purpose() {
        let board = StatusBoard::new(60);
        assert_eq!(
            outcome(
                &board,
                vec![Signal::Revoked("removed".into()), Signal::Restart]
            ),
            Outcome::Revoked
        );
        board.begin_leaving();
        assert_eq!(
            outcome(
                &board,
                vec![
                    Signal::Revoked("moved".into()),
                    Signal::CheckInNow,
                    Signal::Restart
                ]
            ),
            Outcome::Restart
        );
        assert_eq!(
            outcome(
                &board,
                vec![Signal::Revoked("uninstalled".into()), Signal::Stop]
            ),
            Outcome::Stopped
        );
    }

    #[test]
    fn backoff_doubles_to_its_limit_and_resets() {
        let mut b = Backoff::new(Duration::from_secs(5), Duration::from_secs(300));
        let waits: Vec<u64> = (0..9).map(|_| b.next_wait().as_secs()).collect();
        assert_eq!(waits, [5, 10, 20, 40, 80, 160, 300, 300, 300]);
        b.reset();
        assert_eq!(b.next_wait().as_secs(), 5);
    }
}
