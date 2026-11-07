//! What the local page's buttons do: test the connection step by step, move
//! to another server, and uninstall.

use super::pages::{Step, StepResult};
use super::Page;
use crate::client::{Reply, TlsMode};
use crate::inventory::Probe;
use crate::relocate::{self, MoveTarget, Moved, OldServer};
use crate::status::RunMode;
use crate::tls::{self, Check};
use crate::trust;
use crate::updates;
use crate::worker;
use bmuster_protocol::{CertificatePin, CodeOwners, LeaveReason, LocalEvent, ServerTrust};
use rustls::pki_types::ServerName;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs as _};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

fn skipped(name: &'static str) -> Step {
    Step {
        name,
        result: StepResult::Skipped("an earlier step failed".into()),
    }
}

/// Name lookup, network, HTTPS (with this agent's certificate check) and a
/// signed check-in, each with a pass or fail. A failure skips the rest.
pub fn test_connection(page: &Page) -> Vec<Step> {
    let transport = &page.session.transport;
    let server = &transport.server;
    let (host, port) = (server.host(), server.port());
    let mut steps = Vec::new();

    let lookup: Result<Vec<SocketAddr>, String> = match (host, port).to_socket_addrs() {
        Ok(found) => {
            let found: Vec<SocketAddr> = found.collect();
            if found.is_empty() {
                Err(format!("{host} has no addresses"))
            } else {
                Ok(found)
            }
        }
        Err(e) => Err(format!("could not look up {host}: {e}")),
    };
    let addresses = match lookup {
        Ok(found) => {
            steps.push(Step {
                name: "Name lookup",
                result: StepResult::Pass(format!(
                    "{host} is {}",
                    found
                        .iter()
                        .map(|a| a.ip().to_string())
                        .collect::<Vec<_>>()
                        .join(", ")
                )),
            });
            found
        }
        Err(message) => {
            steps.push(Step {
                name: "Name lookup",
                result: StepResult::Fail(message),
            });
            Vec::new()
        }
    };
    if addresses.is_empty() {
        steps.extend(["Network", "HTTPS", "Signed check-in"].map(skipped));
        return steps;
    }

    let mut last_error = None;
    let mut tcp = None;
    for address in &addresses {
        match TcpStream::connect_timeout(address, CONNECT_TIMEOUT) {
            Ok(stream) => {
                tcp = Some((stream, *address));
                break;
            }
            Err(e) => last_error = Some(format!("{address}: {e}")),
        }
    }
    let Some((stream, address)) = tcp else {
        steps.push(Step {
            name: "Network",
            result: StepResult::Fail(format!(
                "could not connect to port {port}: {}",
                last_error.unwrap_or_default()
            )),
        });
        steps.extend(["HTTPS", "Signed check-in"].map(skipped));
        return steps;
    };
    steps.push(Step {
        name: "Network",
        result: StepResult::Pass(format!("connected to {address}")),
    });

    if server.secure() {
        let check = transport.check();
        match tls_handshake(stream, host, check, transport.provider()) {
            Ok(()) => steps.push(Step {
                name: "HTTPS",
                result: StepResult::Pass(format!(
                    "the certificate was accepted: {}",
                    describe(check)
                )),
            }),
            Err(e) => {
                let mut message = format!("{e} (checking: {})", describe(check));
                if let Some(next) = transport.announced() {
                    message.push_str(&format!(
                        "; the server announced a new certificate ({}), which the agent tries on its next connection",
                        trust::describe(&next)
                    ));
                }
                steps.push(Step {
                    name: "HTTPS",
                    result: StepResult::Fail(message),
                });
                steps.push(skipped("Signed check-in"));
                return steps;
            }
        }
    } else {
        steps.push(Step {
            name: "HTTPS",
            result: StepResult::Skipped("plain http:// to a server on this machine".into()),
        });
    }

    let mut probe = lock_probe(page);
    let probe = probe.get_or_insert_with(Probe::new);
    let report = updates::report(&page.data_dir, page.launched);
    let result = match worker::check_in(&page.session, probe, &mut None, &page.people, report) {
        Ok(Reply::Ok(reply)) => {
            let interval = page.board.snapshot().check_in_seconds;
            page.board.checked_in(&reply.machine_name, interval);
            if let Err(e) = page.people.apply(&reply.local_users) {
                log::warn!("Local page: could not save the list of people: {e:#}");
            }
            StepResult::Pass("the server accepted this machine's signed check-in".into())
        }
        Ok(Reply::Refused(refusal)) => StepResult::Fail(format!(
            "the server refused: {} ({})",
            refusal.message, refusal.reason
        )),
        Err(e) => StepResult::Fail(format!("{e:#}")),
    };
    steps.push(Step {
        name: "Signed check-in",
        result,
    });
    steps
}

pub fn lock_probe(page: &Page) -> std::sync::MutexGuard<'_, Option<Probe>> {
    page.probe
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn describe(check: Check) -> String {
    match check {
        Check::AnyCertificate => "NOT checked (--insecure-dev-tls, development only)".into(),
        Check::Trust(trust) => trust::describe(&trust),
    }
}

fn tls_handshake(
    mut stream: TcpStream,
    host: &str,
    check: Check,
    provider: std::sync::Arc<rustls::crypto::CryptoProvider>,
) -> Result<(), String> {
    let config = tls::client_config(check, provider).map_err(|e| format!("{e:#}"))?;
    let name = ServerName::try_from(host.to_string()).map_err(|e| e.to_string())?;
    let mut connection = rustls::ClientConnection::new(config, name).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(CONNECT_TIMEOUT))
        .and_then(|()| stream.set_write_timeout(Some(CONNECT_TIMEOUT)))
        .map_err(|e| e.to_string())?;
    while connection.is_handshaking() {
        connection
            .complete_io(&mut stream)
            .map_err(|e| format!("the TLS handshake failed: {e}"))?;
    }
    Ok(())
}

/// What the move form sent.
pub struct MoveForm {
    pub url: String,
    pub code: String,
    pub pin: String,
    pub name: String,
}

pub enum MoveResult {
    Moved(Moved),
    Failed(String),
}

/// Sends waiting events to the current server before it is told the machine
/// is leaving: it refuses the machine afterwards.
fn send_events_before_leaving(page: &Page) {
    if let Err(e) = page.journal.send(&page.session) {
        log::warn!("Could not send the local page's events before leaving: {e:#}");
    }
}

pub fn move_machine(page: &Page, form: &MoveForm, codes: &CodeOwners) -> MoveResult {
    let Ok(_busy) = page.busy.try_lock() else {
        return MoveResult::Failed("A move or uninstall is already running.".into());
    };
    let pin = form.pin.trim();
    let pin = if pin.is_empty() {
        None
    } else {
        match CertificatePin::parse(pin) {
            Ok(pin) => Some(pin),
            Err(e) => return MoveResult::Failed(format!("The certificate pin: {e}.")),
        }
    };
    let tls = match (pin, page.insecure_dev_tls) {
        (Some(pin), _) => TlsMode::Checked(ServerTrust::Pin { pin }),
        // A development copy (--insecure-dev-tls) moves the same way.
        (None, true) => TlsMode::InsecureDev,
        (None, false) => TlsMode::Checked(ServerTrust::Public),
    };
    let name = form.name.trim();
    let url = form.url.trim();
    page.journal.record(LocalEvent::MoveStarted {
        codes: codes.clone(),
        server_url: url.to_string(),
    });
    page.board.begin_leaving();
    let before_leave = || {
        page.journal.record(LocalEvent::MoveFinished {
            codes: codes.clone(),
            server_url: url.to_string(),
        });
        page.journal.record(LocalEvent::Leaving {
            codes: codes.clone(),
            reason: LeaveReason::Moved,
        });
        send_events_before_leaving(page);
    };
    let result = relocate::move_to(
        &page.data_dir,
        &MoveTarget {
            url,
            code: &form.code,
            name: (!name.is_empty()).then_some(name),
            tls,
        },
        &page.session,
        &before_leave,
    );
    match result {
        Ok(moved) => MoveResult::Moved(moved),
        Err(e) => {
            if !relocate::move_pending(&page.data_dir) {
                page.board.end_leaving();
            }
            page.journal.record(LocalEvent::MoveFailed {
                codes: codes.clone(),
                reason: format!("{e:#}"),
            });
            MoveResult::Failed(format!("{e:#}"))
        }
    }
}

pub fn old_server_text(old: &OldServer) -> String {
    match old {
        OldServer::Told => "The old server was told; it shows this machine as moved and refuses its old identity.".into(),
        OldServer::NotTold(reason) => format!(
            "The old server could not be told ({reason}). Remove the machine there by hand when it is reachable."
        ),
    }
}

/// What the uninstall page says will happen.
pub fn uninstall_explanation(page: &Page) -> String {
    match page.mode {
        RunMode::Service => "The agent tells its server it is leaving, then removes its service, its program and its data folder (identity and key), the same as `bmuster-agent uninstall --purge`. The server refuses this machine from then on. This page stops working.".into(),
        RunMode::Foreground => format!(
            "This agent was started by hand, not by a service (a development copy). It tells its server it is leaving, deletes its data folder {} (identity and key) and stops. No service or program files are removed.",
            page.data_dir.display()
        ),
    }
}

pub enum Uninstall {
    /// Scheduled outside the agent (service); it stops this process shortly.
    Scheduled(Vec<String>),
    /// A development copy: delete the data folder and stop after replying.
    RemoveDataAndStop(Vec<String>),
    Failed(String),
}

pub fn uninstall(page: &Page, codes: CodeOwners) -> Uninstall {
    let Ok(_busy) = page.busy.try_lock() else {
        return Uninstall::Failed("A move or uninstall is already running.".into());
    };
    page.journal.record(LocalEvent::Uninstalled {
        codes: codes.clone(),
    });
    page.journal.record(LocalEvent::Leaving {
        codes,
        reason: LeaveReason::Uninstalled,
    });
    send_events_before_leaving(page);
    page.board.begin_leaving();
    let mut said = vec![match relocate::leave(&page.session, LeaveReason::Uninstalled) {
        Ok(()) => "The server was told this machine is leaving; it refuses the machine from now on.".to_string(),
        Err(e) => format!(
            "The server could not be told ({e:#}). Remove the machine in the console when it is reachable."
        ),
    }];
    match page.mode {
        RunMode::Service => match crate::platform::schedule_uninstall() {
            Ok(()) => {
                said.push("The agent removes its service, program and data in a few seconds. You can close this page.".into());
                Uninstall::Scheduled(said)
            }
            Err(e) => {
                said.push(format!(
                    "Could not start the uninstall ({e:#}). Run `bmuster-agent uninstall --purge` as root or Administrator to finish."
                ));
                Uninstall::Failed(said.join(" "))
            }
        },
        RunMode::Foreground => {
            said.push(format!(
                "Deleting {} and stopping the agent. The program itself stays where it is.",
                page.data_dir.display()
            ));
            Uninstall::RemoveDataAndStop(said)
        }
    }
}
