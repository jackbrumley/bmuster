//! The agent's local page (SPEC-AGENT-LOCAL): a small HTTPS site on this
//! machine, by default `https://localhost:47500` (Wannon Beacon uses 47400),
//! for someone at the machine to check the agent, fix its connection, move it
//! to another server or uninstall it, even while the internet is down.
//!
//! Sign-in is a 6-digit code (TOTP) the console shows to admins; the secret
//! is made here and sent once to the server in a signed request. Each person
//! on the server's list has their own code derived from it, and what happens
//! here is reported to the server's Activity (SPEC-AGENT-LOCAL 7).

mod actions;
mod certificate;
mod gate;
mod http;
pub mod journal;
mod pages;
pub mod people;
mod routes;

use crate::client::{Reply, Session};
use crate::identity::write_private;
use crate::inventory::Probe;
use crate::paths::{LOCAL_PAGE_CONFIG_FILE, LOCAL_PAGE_REPORTED_FILE};
use crate::status::{RunMode, StatusBoard};
use crate::worker::Signal;
use anyhow::{bail, Context as _, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use bmuster_protocol::{LocalPageReport, LOCAL_PAGE_PATH};
use gate::{Gate, Hosts};
use journal::Journal;
use people::People;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{ServerConfig, ServerConnection, StreamOwned};
use serde::Deserialize;
use std::fs;
use std::io::Write as _;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const DEFAULT_PORT: u16 = 47500;
/// Connections beyond this many at once are dropped.
const MAX_CONNECTIONS: usize = 16;
const IO_TIMEOUT: Duration = Duration::from_secs(15);
/// After a failed report, wait this long before trying again.
const REPORT_RETRY: Duration = Duration::from_secs(3600);
/// How often sessions that ran out unused are ended and recorded.
const SWEEP_EVERY: Duration = Duration::from_secs(60);

/// What the worker hands the page.
pub struct Setup {
    pub data_dir: PathBuf,
    pub session: Arc<Session>,
    pub signals: Sender<Signal>,
    pub board: Arc<StatusBoard>,
    pub mode: RunMode,
    pub insecure_dev_tls: bool,
    pub port_override: Option<u16>,
    pub people: Arc<People>,
    pub journal: Arc<Journal>,
    /// Started by the launcher, so it can update itself (SPEC-AGENT-UPDATES).
    pub launched: bool,
}

/// The running page's shared state.
pub struct Page {
    data_dir: PathBuf,
    session: Arc<Session>,
    signals: Mutex<Sender<Signal>>,
    board: Arc<StatusBoard>,
    mode: RunMode,
    insecure_dev_tls: bool,
    launched: bool,
    gate: Gate,
    people: Arc<People>,
    journal: Arc<Journal>,
    hosts: Hosts,
    listen: Vec<SocketAddr>,
    /// The certificate's SHA-256 as browsers show it.
    fingerprint: String,
    /// Kept between page views so CPU use is measured over real time.
    probe: Mutex<Option<Probe>>,
    /// One move or uninstall at a time.
    busy: Mutex<()>,
    connections: AtomicUsize,
}

impl Page {
    fn send(&self, signal: Signal) {
        let sender = self
            .signals
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if sender.send(signal).is_err() {
            log::warn!("Local page: the agent's main loop has stopped.");
        }
    }
}

/// `local-page.json` in the data folder: `{ "listen": "0.0.0.0:47500" }`
/// opens the page to the local network (opt-in, like Wannon Beacon).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    listen: String,
}

struct Listen {
    addresses: Vec<SocketAddr>,
    hosts: Hosts,
}

fn loopback(port: u16) -> Listen {
    Listen {
        addresses: vec![
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
            SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
        ],
        hosts: Hosts {
            port,
            loopback_only: true,
        },
    }
}

fn listen_addresses(dir: &Path, port_override: Option<u16>) -> Result<Listen> {
    if let Some(port) = port_override {
        return Ok(loopback(port));
    }
    let path = dir.join(LOCAL_PAGE_CONFIG_FILE);
    if !path.exists() {
        return Ok(loopback(DEFAULT_PORT));
    }
    let text =
        fs::read_to_string(&path).with_context(|| format!("could not read {}", path.display()))?;
    let config: Config = serde_json::from_str(&text).with_context(|| {
        format!(
            "{} is not valid; it holds {{ \"listen\": \"0.0.0.0:{DEFAULT_PORT}\" }}",
            path.display()
        )
    })?;
    let address: SocketAddr = config.listen.parse().with_context(|| {
        format!(
            "{}: \"{}\" is not an address and port like 0.0.0.0:{DEFAULT_PORT}",
            path.display(),
            config.listen
        )
    })?;
    if address.ip().is_loopback() {
        return Ok(loopback(address.port()));
    }
    Ok(Listen {
        addresses: vec![address],
        hosts: Hosts {
            port: address.port(),
            loopback_only: false,
        },
    })
}

fn server_config(cert: &certificate::PageCertificate) -> Result<Arc<ServerConfig>> {
    let config = ServerConfig::builder_with_provider(crate::tls::crypto_provider())
        .with_safe_default_protocol_versions()
        .context("could not set up TLS for the local page")?
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(cert.cert_der.clone())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(cert.key_der.clone())),
        )
        .context("the local page's certificate or key is damaged; delete local-page.crt and local-page.key")?;
    Ok(Arc::new(config))
}

/// Starts the page on its own threads. The agent keeps working without it,
/// so a failure is logged, not fatal. Returns what sends the secret to the
/// server once the page runs.
pub fn start(setup: Setup) -> Option<Reporter> {
    match try_start(setup) {
        Ok(reporter) => Some(reporter),
        Err(e) => {
            log::warn!("The local page is not available: {e:#}");
            None
        }
    }
}

fn try_start(setup: Setup) -> Result<Reporter> {
    let listen = listen_addresses(&setup.data_dir, setup.port_override)?;
    let secret = certificate::load_or_create_secret(&setup.data_dir)?;
    let cert = certificate::load_or_create_certificate(&setup.data_dir)?;
    let tls = server_config(&cert)?;

    let mut listeners = Vec::new();
    for address in &listen.addresses {
        match TcpListener::bind(address) {
            Ok(listener) => listeners.push((*address, listener)),
            // IPv6 may be off; 127.0.0.1 is enough then.
            Err(e) if address.is_ipv6() && listen.hosts.loopback_only => {
                log::debug!("Local page: not listening on {address}: {e}");
            }
            Err(e) => log::warn!("Local page: could not listen on {address}: {e}"),
        }
    }
    if listeners.is_empty() {
        bail!(
            "could not listen on {} (is another copy of the agent running?)",
            listen
                .addresses
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(" or ")
        );
    }

    let page = Arc::new(Page {
        data_dir: setup.data_dir.clone(),
        session: Arc::clone(&setup.session),
        signals: Mutex::new(setup.signals),
        board: setup.board,
        mode: setup.mode,
        insecure_dev_tls: setup.insecure_dev_tls,
        gate: Gate::new(
            &secret,
            Arc::clone(&setup.people),
            Arc::clone(&setup.journal),
        ),
        people: setup.people,
        journal: setup.journal,
        launched: setup.launched,
        hosts: listen.hosts,
        listen: listeners.iter().map(|(address, _)| *address).collect(),
        fingerprint: certificate::fingerprint(&cert.sha256_hex),
        probe: Mutex::new(None),
        busy: Mutex::new(()),
        connections: AtomicUsize::new(0),
    });
    if setup.launched && setup.mode == RunMode::Service {
        crate::tray::publish(Arc::clone(&page.board), page.hosts.port);
    }
    {
        let page = Arc::clone(&page);
        std::thread::Builder::new()
            .name("local-page sweep".into())
            .spawn(move || loop {
                std::thread::sleep(SWEEP_EVERY);
                if page.gate.sweep(journal::now_ms()) {
                    routes::send_events_soon(&page);
                }
            })
            .context("could not start the local page")?;
    }
    for (address, listener) in listeners {
        let page = Arc::clone(&page);
        let tls = Arc::clone(&tls);
        std::thread::Builder::new()
            .name(format!("local-page {address}"))
            .spawn(move || accept_loop(&page, &listener, &tls))
            .context("could not start the local page")?;
    }
    log::info!(
        "Local page: https://localhost:{} (certificate SHA-256 {})",
        listen.hosts.port,
        page.fingerprint
    );
    if !listen.hosts.loopback_only {
        log::warn!(
            "Local page: open to the network on {}. BMuster does not change the firewall; \
             open TCP {} yourself if it should be reachable.",
            page.listen
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(", "),
            listen.hosts.port
        );
    }
    Ok(Reporter::new(
        &setup.data_dir,
        LocalPageReport {
            totp_secret: BASE64.encode(&secret),
            certificate_sha256: cert.sha256_hex,
            port: listen.hosts.port,
        },
    ))
}

fn accept_loop(page: &Arc<Page>, listener: &TcpListener, tls: &Arc<ServerConfig>) {
    for stream in listener.incoming() {
        let Ok(stream) = stream else {
            continue;
        };
        if page.connections.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            page.connections.fetch_sub(1, Ordering::SeqCst);
            let _ = stream.shutdown(Shutdown::Both);
            continue;
        }
        let page = Arc::clone(page);
        let tls = Arc::clone(tls);
        let spawned = std::thread::Builder::new()
            .name("local-page connection".into())
            .spawn(move || {
                serve_connection(&page, stream, tls);
                page.connections.fetch_sub(1, Ordering::SeqCst);
            });
        if spawned.is_err() {
            log::warn!("Local page: could not start a thread for a connection.");
        }
    }
}

fn serve_connection(page: &Page, tcp: TcpStream, tls: Arc<ServerConfig>) {
    if tcp.set_read_timeout(Some(IO_TIMEOUT)).is_err()
        || tcp.set_write_timeout(Some(IO_TIMEOUT)).is_err()
    {
        return;
    }
    let Ok(connection) = ServerConnection::new(tls) else {
        return;
    };
    let mut stream = StreamOwned::new(connection, tcp);
    let (response, after) = match http::read_request(&mut stream) {
        Ok(request) => routes::handle(page, &request),
        // A browser that gave up, a plain-HTTP visitor or a refused certificate.
        Err(http::ReadError::Closed) => return,
        Err(http::ReadError::Bad(reason)) => {
            (http::Response::text(400, reason), routes::After::Nothing)
        }
    };
    let _ = response.write_to(&mut stream);
    stream.conn.send_close_notify();
    let _ = stream.flush();
    let _ = stream.sock.shutdown(Shutdown::Both);
    drop(stream);
    routes::run_after(page, after);
}

/// Sends the page's secret, certificate and port to the server once per
/// enrolment (`POST /agent/v1/local-page`, signed), after a check-in works.
pub struct Reporter {
    path: PathBuf,
    report: LocalPageReport,
    /// The machine id it was last sent for.
    sent_for: Option<String>,
    next_attempt: Instant,
}

impl Reporter {
    fn new(dir: &Path, report: LocalPageReport) -> Self {
        let path = dir.join(LOCAL_PAGE_REPORTED_FILE);
        let sent_for = fs::read_to_string(&path)
            .ok()
            .map(|text| text.trim().to_string());
        Self {
            path,
            report,
            sent_for,
            next_attempt: Instant::now(),
        }
    }

    pub fn after_check_in(&mut self, session: &Session) {
        if self.sent_for.as_deref() == Some(session.machine_id.as_str())
            || Instant::now() < self.next_attempt
        {
            return;
        }
        match self.send(session) {
            Ok(()) => {
                log::info!("Sent the local page's sign-in secret to the server.");
                self.sent_for = Some(session.machine_id.clone());
                if let Err(e) = write_private(&self.path, session.machine_id.as_bytes()) {
                    log::warn!("Could not note that the local page secret was sent: {e}");
                }
            }
            Err(e) => {
                log::warn!(
                    "Could not send the local page's sign-in secret to the server \
                     (an older server does not take it): {e:#}"
                );
                self.next_attempt = Instant::now() + REPORT_RETRY;
            }
        }
    }

    fn send(&self, session: &Session) -> Result<()> {
        let body = serde_json::to_vec(&self.report)?;
        match session.post_signed::<serde::de::IgnoredAny>(LOCAL_PAGE_PATH, &body)? {
            Reply::Ok(_) => Ok(()),
            Reply::Refused(refusal) => bail!("{} ({})", refusal.message, refusal.reason),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listens_on_loopback_unless_told_otherwise() {
        let dir = tempfile::tempdir().unwrap();
        let listen = listen_addresses(dir.path(), None).unwrap();
        assert_eq!(
            listen.addresses,
            [
                "127.0.0.1:47500".parse::<SocketAddr>().unwrap(),
                "[::1]:47500".parse().unwrap()
            ]
        );
        assert!(listen.hosts.loopback_only);

        let flag = listen_addresses(dir.path(), Some(47591)).unwrap();
        assert_eq!(flag.hosts.port, 47591);
        assert!(flag.hosts.loopback_only);

        fs::write(
            dir.path().join(LOCAL_PAGE_CONFIG_FILE),
            r#"{ "listen": "0.0.0.0:47500" }"#,
        )
        .unwrap();
        let open = listen_addresses(dir.path(), None).unwrap();
        assert_eq!(
            open.addresses,
            ["0.0.0.0:47500".parse::<SocketAddr>().unwrap()]
        );
        assert!(!open.hosts.loopback_only);

        fs::write(
            dir.path().join(LOCAL_PAGE_CONFIG_FILE),
            r#"{ "listen": "everywhere" }"#,
        )
        .unwrap();
        assert!(listen_addresses(dir.path(), None).is_err());
        fs::write(dir.path().join(LOCAL_PAGE_CONFIG_FILE), r#"{ "port": 1 }"#).unwrap();
        assert!(listen_addresses(dir.path(), None).is_err());
    }
}
