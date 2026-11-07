//! `bmuster-agent run`: the check-in loop on this thread and the live socket
//! on its own thread.

use crate::client::{Reply, Security, ServerUrl, Session, Transport};
use crate::identity;
use crate::inventory::{self, Probe};
use crate::socket;
use crate::trust::{Trust, TrustState};
use anyhow::{Context as _, Result};
use bmuster_protocol::{
    CheckInReply, CheckInRequest, InventoryReport, Refusal, RefusalReason, CHECK_IN_PATH,
};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::Duration;

/// Messages to the check-in loop.
pub enum Signal {
    CheckInNow,
    Revoked(String),
    /// The service manager asked the agent to stop (Windows).
    #[cfg_attr(not(windows), allow(dead_code))]
    Stop,
}

/// How `run` ended without an error.
pub enum Outcome {
    Stopped,
    Revoked,
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
}

/// Runs until revoked or stopped. `signals` is the check-in loop's inbox; its
/// sender is shared with the socket thread and (on Windows) the service.
pub fn run(
    options: &RunOptions,
    sender: Sender<Signal>,
    signals: Receiver<Signal>,
) -> Result<Outcome> {
    let identity = identity::load(&options.data_dir)?;
    let key = identity::load_key(&options.data_dir)?;
    let server = ServerUrl::parse(&identity.server_url)?;
    let security = if options.insecure_dev_tls {
        Security::InsecureDev
    } else {
        let dir = options.data_dir.clone();
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
    let transport = Transport::new(server.clone(), security);
    let session = Arc::new(Session::new(transport, identity.machine_id.clone(), key));
    log::info!(
        "BMuster agent {} started: machine {}, server {}",
        env!("CARGO_PKG_VERSION"),
        identity.machine_id,
        server.base()
    );

    let stop = Arc::new(AtomicBool::new(false));
    let socket_thread = {
        let session = Arc::clone(&session);
        let stop = Arc::clone(&stop);
        std::thread::Builder::new()
            .name("live-socket".into())
            .spawn(move || socket::run(&session, &sender, &stop))
            .context("could not start the live socket thread")?
    };

    let outcome = check_in_loop(
        &session,
        &options.data_dir,
        identity.check_in_seconds,
        &signals,
    );
    stop.store(true, Ordering::SeqCst);
    if socket_thread.join().is_err() {
        log::error!("the live socket thread failed");
    }
    outcome
}

fn check_in_loop(
    session: &Session,
    data_dir: &Path,
    mut check_in_seconds: u32,
    signals: &Receiver<Signal>,
) -> Result<Outcome> {
    let mut probe = Probe::new();
    // The inventory hash the server is known to hold; `None` sends it in full.
    let mut server_hash: Option<String> = None;
    let mut backoff = Backoff::new(Duration::from_secs(5), Duration::from_secs(300));

    loop {
        let wait = match check_in(session, &mut probe, &mut server_hash) {
            Ok(Reply::Ok(reply)) => {
                backoff.reset();
                match identity::check_interval(reply.check_in_seconds) {
                    Ok(seconds) if seconds != check_in_seconds => {
                        log::info!("The server set the check-in interval to {seconds} s.");
                        check_in_seconds = seconds;
                        identity::update(data_dir, |saved| saved.check_in_seconds = seconds)?;
                    }
                    Ok(_) => {}
                    Err(e) => log::warn!("Ignoring the new interval: {e:#}"),
                }
                Duration::from_secs(u64::from(check_in_seconds))
            }
            Ok(Reply::Refused(Refusal {
                reason: RefusalReason::Revoked,
                message,
            })) => {
                log_revoked(&message);
                return Ok(Outcome::Revoked);
            }
            Ok(Reply::Refused(refusal)) => {
                let wait = backoff.next_wait();
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
                log::warn!("Check-in failed: {e:#}; retrying in {} s", wait.as_secs());
                wait
            }
        };

        match signals.recv_timeout(wait) {
            Ok(Signal::CheckInNow) | Err(RecvTimeoutError::Timeout) => {}
            Ok(Signal::Revoked(message)) => {
                log_revoked(&message);
                return Ok(Outcome::Revoked);
            }
            Ok(Signal::Stop) | Err(RecvTimeoutError::Disconnected) => {
                log::info!("Stopping.");
                return Ok(Outcome::Stopped);
            }
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
fn check_in(
    session: &Session,
    probe: &mut Probe,
    server_hash: &mut Option<String>,
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
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
        uptime_seconds: inventory::uptime_seconds(),
        signed_in_user: inventory::signed_in_user(),
        load: probe.load(),
        inventory: report,
    };
    let body = serde_json::to_vec(&request)?;
    let reply = session.transport.exchange(|channel| {
        // Signed afresh for each attempt, so a retry never repeats a timestamp.
        let signed = session.sign("POST", CHECK_IN_PATH, &body);
        let reply = channel.post::<CheckInReply>(
            CHECK_IN_PATH,
            &body,
            Some(&signed.authorization),
            |date| session.observe_date(date),
        );
        drop(signed);
        reply
    })?;
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

    #[test]
    fn backoff_doubles_to_its_limit_and_resets() {
        let mut b = Backoff::new(Duration::from_secs(5), Duration::from_secs(300));
        let waits: Vec<u64> = (0..9).map(|_| b.next_wait().as_secs()).collect();
        assert_eq!(waits, [5, 10, 20, 40, 80, 160, 300, 300, 300]);
        b.reset();
        assert_eq!(b.next_wait().as_secs(), 5);
    }
}
