//! Talking to the server: the server URL, the HTTP and socket clients (TLS is
//! in `tls.rs`, trust changes in `trust.rs`), signed requests and the clock
//! correction that keeps signed timestamps inside the server's window.

use crate::tls::{self, Check};
use crate::trust::{Trust, TrustState};
use anyhow::{anyhow, bail, Context as _, Result};
use bmuster_protocol::ServerTrust;
use bmuster_protocol::{authorization_header, sign_request, Refusal};
use ed25519_dalek::SigningKey;
use rustls::crypto::CryptoProvider;
use rustls::ClientConfig;
use serde::de::DeserializeOwned;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use ureq::http::Uri;
use ureq::unversioned::resolver::DefaultResolver;
use ureq::unversioned::transport::{ConnectProxyConnector, Connector as _, TcpConnector};

pub const USER_AGENT: &str = concat!("bmuster-agent/", env!("CARGO_PKG_VERSION"));
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
/// The `Date` header has one-second resolution; ignore differences below this.
const DRIFT_TOLERANCE_MS: i64 = 2_000;

// ---------------------------------------------------------------------------
// Server URL
// ---------------------------------------------------------------------------

/// A checked server base URL, for example `https://bmuster.example.com` or
/// `https://example.com/bmuster` (a path prefix is kept and signed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerUrl {
    secure: bool,
    /// `host` or `host:port`, as typed (IPv6 in brackets).
    authority: String,
    host: String,
    port: u16,
    /// Empty, or `/prefix` without a trailing slash.
    prefix: String,
}

impl ServerUrl {
    pub fn parse(text: &str) -> Result<Self> {
        let uri: Uri = text
            .trim()
            .parse()
            .with_context(|| format!("{text} is not a valid URL"))?;
        let secure = match uri.scheme_str() {
            Some("https") => true,
            Some("http") => false,
            _ => bail!("the server URL must start with https:// (got {text})"),
        };
        let authority = uri
            .authority()
            .ok_or_else(|| anyhow!("the server URL {text} has no host"))?;
        if authority.as_str().contains('@') {
            bail!("the server URL must not contain a user name or password");
        }
        if uri.query().is_some() {
            bail!("the server URL must not contain a query string");
        }
        let host = authority
            .host()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_string();
        if !secure && !is_loopback(&host) {
            bail!(
                "plain http:// is only allowed for a server on this machine (localhost); \
                 use https:// for {host}"
            );
        }
        let port = authority
            .port_u16()
            .unwrap_or(if secure { 443 } else { 80 });
        let prefix = uri.path().trim_end_matches('/').to_string();
        Ok(Self {
            secure,
            authority: authority.as_str().to_string(),
            host,
            port,
            prefix,
        })
    }

    /// The URL as stored in `identity.json`.
    pub fn base(&self) -> String {
        let scheme = if self.secure { "https" } else { "http" };
        format!("{scheme}://{}{}", self.authority, self.prefix)
    }

    /// The path the server sees, which is what gets signed.
    pub fn signed_path(&self, path: &str) -> String {
        format!("{}{path}", self.prefix)
    }

    pub fn http_url(&self, path: &str) -> String {
        format!("{}{path}", self.base())
    }

    pub fn ws_url(&self, path: &str) -> String {
        let scheme = if self.secure { "wss" } else { "ws" };
        format!("{scheme}://{}{}{path}", self.authority, self.prefix)
    }

    pub fn host(&self) -> &str {
        &self.host
    }

    pub fn port(&self) -> u16 {
        self.port
    }
}

fn is_loopback(host: &str) -> bool {
    host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/// How a command checks the server's certificate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsMode {
    /// The system's trust store, or a pinned key (`--pin-cert`).
    Checked(ServerTrust),
    /// `--insecure-dev-tls`: any certificate is accepted. Development only.
    InsecureDev,
}

/// How a transport checks the server: a trust that can follow a planned
/// certificate change (L7), or none at all (`--insecure-dev-tls`).
pub enum Security {
    Checked(Trust),
    InsecureDev,
}

impl Security {
    /// A one-off trust that is never saved (enrolment).
    pub fn once(mode: TlsMode) -> Self {
        match mode {
            TlsMode::Checked(trust) => Security::Checked(Trust::new(
                TrustState::new(trust, None),
                Box::new(|_| Ok(())),
            )),
            TlsMode::InsecureDev => Security::InsecureDev,
        }
    }
}

/// What came back from the server.
pub enum Reply<T> {
    Ok(T),
    Refused(Refusal),
}

/// HTTP and WebSocket clients for one way of checking the server.
pub struct Channel {
    server: ServerUrl,
    http: ureq::Agent,
    pub websocket_tls: Arc<ClientConfig>,
}

impl Channel {
    fn new(server: &ServerUrl, check: Check, provider: Arc<CryptoProvider>) -> Result<Self> {
        let config = tls::client_config(check, provider)?;
        // Proxies come from HTTPS_PROXY / ALL_PROXY / NO_PROXY, and on Windows
        // from the system proxy setting (ureq's default).
        let settings = ureq::Agent::config_builder()
            .http_status_as_error(false)
            .max_redirects(0)
            .timeout_global(Some(HTTP_TIMEOUT))
            .user_agent(USER_AGENT)
            .build();
        let connector =
            ().chain(ConnectProxyConnector::default())
                .chain(TcpConnector::default())
                .chain(tls::RustlsConnector(config.clone()));
        Ok(Self {
            server: server.clone(),
            http: ureq::Agent::with_parts(settings, connector, DefaultResolver::default()),
            websocket_tls: config,
        })
    }

    /// POSTs `body` (already-serialised JSON) and reads a reply or refusal.
    /// `on_date` sees the server's `Date` header, whatever the status.
    pub fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &[u8],
        authorization: Option<&str>,
        on_date: impl FnOnce(Option<&str>),
    ) -> Result<Reply<T>> {
        let url = self.server.http_url(path);
        let mut request = self
            .http
            .post(&url)
            .header("content-type", "application/json");
        if let Some(value) = authorization {
            request = request.header("authorization", value);
        }
        let mut response = request
            .send(body)
            .with_context(|| format!("could not reach {url}"))?;
        on_date(
            response
                .headers()
                .get("date")
                .and_then(|value| value.to_str().ok()),
        );
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .read_to_string()
            .with_context(|| format!("could not read the reply from {url}"))?;
        parse_reply(status, &text).with_context(|| format!("unexpected reply from {url}"))
    }
}

/// Talks to one server, checking its certificate the way `Security` says.
pub struct Transport {
    pub server: ServerUrl,
    provider: Arc<CryptoProvider>,
    security: Security,
    /// The channel for the check last used; rebuilt when the check changes.
    cached: Mutex<Option<(Check, Arc<Channel>)>>,
}

impl Transport {
    pub fn new(server: ServerUrl, security: Security) -> Self {
        match &security {
            Security::InsecureDev => {
                log::warn!("**************************************************************");
                log::warn!("--insecure-dev-tls: the server's certificate is NOT checked.");
                log::warn!("Anyone on the network path can pretend to be the server.");
                log::warn!("Use this only against a development server on your own machine.");
                log::warn!("**************************************************************");
            }
            Security::Checked(trust) => {
                if let ServerTrust::Pin { pin } = trust.state().current {
                    log::info!("Trusting only the server certificate key {pin}.");
                }
            }
        }
        if !server.secure {
            log::warn!(
                "Talking to {} over plain http://; traffic is not encrypted.",
                server.base()
            );
        }
        Self {
            server,
            provider: tls::crypto_provider(),
            security,
            cached: Mutex::new(None),
        }
    }

    fn channel(&self, check: Check) -> Result<Arc<Channel>> {
        let mut cached = lock(&self.cached);
        if let Some((cached_check, channel)) = cached.as_ref() {
            if *cached_check == check {
                return Ok(Arc::clone(channel));
            }
        }
        let channel = Arc::new(Channel::new(&self.server, check, self.provider.clone())?);
        *cached = Some((check, Arc::clone(&channel)));
        Ok(channel)
    }

    /// Runs one exchange with the server. If it fails under the current
    /// certificate check and the server announced a change, it is tried once
    /// more under the announced check, which is adopted if it works (L7).
    pub fn exchange<T>(&self, mut attempt: impl FnMut(&Channel) -> Result<T>) -> Result<T> {
        match &self.security {
            Security::InsecureDev => attempt(&*self.channel(Check::AnyCertificate)?),
            Security::Checked(trust) => {
                trust.with_fallback(|check| attempt(&*self.channel(Check::Trust(*check))?))
            }
        }
    }

    /// The server announced the certificate it serves after its next restart.
    pub fn announce(&self, next: ServerTrust) {
        match &self.security {
            Security::Checked(trust) => trust.announce(next),
            Security::InsecureDev => {
                log::debug!("Ignoring a certificate pin announcement (--insecure-dev-tls).");
            }
        }
    }
}

/// HTTP 200 → reply; 400/401/404/409 → refusal; anything else is an error.
pub fn parse_reply<T: DeserializeOwned>(status: u16, text: &str) -> Result<Reply<T>> {
    match status {
        200 => Ok(Reply::Ok(
            serde_json::from_str(text).context("the reply is not the expected JSON")?,
        )),
        400 | 401 | 404 | 409 => match serde_json::from_str::<Refusal>(text) {
            Ok(refusal) => Ok(Reply::Refused(refusal)),
            Err(_) => bail!("HTTP {status} without a refusal reason: {}", excerpt(text)),
        },
        _ => bail!("HTTP {status}: {}", excerpt(text)),
    }
}

fn excerpt(text: &str) -> String {
    let trimmed: String = text.trim().chars().take(200).collect();
    if trimmed.is_empty() {
        "(empty body)".into()
    } else {
        trimmed
    }
}

// ---------------------------------------------------------------------------
// Signing and clock
// ---------------------------------------------------------------------------

struct Clock {
    /// Server time minus local time.
    offset_ms: i64,
    /// Last timestamp signed; the next is always larger.
    last_ms: i64,
}

/// A signed-in connection to the server, shared by the check-in loop and the
/// live socket.
pub struct Session {
    pub transport: Transport,
    pub machine_id: String,
    key: SigningKey,
    clock: Mutex<Clock>,
    /// Held from signing until the request is sent, so the server sees
    /// timestamps in increasing order even with two threads.
    order: Mutex<()>,
}

pub struct Signed<'a> {
    pub authorization: String,
    _order: MutexGuard<'a, ()>,
}

fn local_now_ms() -> i64 {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic aborts the process (panic = "abort"), so poisoning cannot leave
    // half-updated state behind; take the guard either way.
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Session {
    pub fn new(transport: Transport, machine_id: String, key: SigningKey) -> Self {
        Self {
            transport,
            machine_id,
            key,
            clock: Mutex::new(Clock {
                offset_ms: 0,
                last_ms: 0,
            }),
            order: Mutex::new(()),
        }
    }

    fn next_timestamp(&self) -> i64 {
        let mut clock = lock(&self.clock);
        let now = local_now_ms() + clock.offset_ms;
        let next = now.max(clock.last_ms + 1);
        clock.last_ms = next;
        next
    }

    /// Signs one request. Keep the result alive until the request is sent.
    pub fn sign(&self, method: &str, path: &str, body: &[u8]) -> Signed<'_> {
        let order = lock(&self.order);
        let signed_path = self.transport.server.signed_path(path);
        let timestamp = self.next_timestamp();
        let signature = sign_request(&self.key, method, &signed_path, timestamp, body);
        Signed {
            authorization: authorization_header(&self.machine_id, timestamp, &signature),
            _order: order,
        }
    }

    /// Corrects the clock from the server's `Date` header.
    pub fn observe_date(&self, date: Option<&str>) {
        let Some(text) = date else {
            log::debug!("the server sent no Date header");
            return;
        };
        let Ok(server_time) = httpdate::parse_http_date(text) else {
            log::warn!("the server sent an unreadable Date header: {text}");
            return;
        };
        let Ok(since) = server_time.duration_since(UNIX_EPOCH) else {
            log::warn!("the server's Date header is before 1970: {text}");
            return;
        };
        // The header drops milliseconds; the true time is up to a second later.
        let server_ms = i64::try_from(since.as_millis()).unwrap_or(i64::MAX) + 500;
        let local = local_now_ms();
        let offset = server_ms - local;
        let mut clock = lock(&self.clock);
        if (offset - clock.offset_ms).abs() > DRIFT_TOLERANCE_MS {
            log::info!(
                "This machine's clock is {} ms {} the server's; correcting signed timestamps.",
                offset.abs(),
                if offset > 0 { "behind" } else { "ahead of" }
            );
            clock.offset_ms = offset;
            // A timestamp signed with the wrong clock may sit far in the
            // future; let the corrected clock take over.
            clock.last_ms = clock.last_ms.min(local + offset);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bmuster_protocol::{CheckInReply, RefusalReason};

    #[test]
    fn server_url_keeps_prefix_and_signs_full_path() {
        let url = ServerUrl::parse("https://example.com:8443/bmuster/").unwrap();
        assert_eq!(url.base(), "https://example.com:8443/bmuster");
        assert_eq!(
            url.http_url("/agent/v1/check-in"),
            "https://example.com:8443/bmuster/agent/v1/check-in"
        );
        assert_eq!(
            url.signed_path("/agent/v1/check-in"),
            "/bmuster/agent/v1/check-in"
        );
        assert_eq!(
            url.ws_url("/agent/v1/socket"),
            "wss://example.com:8443/bmuster/agent/v1/socket"
        );
        assert_eq!(url.port(), 8443);
    }

    #[test]
    fn server_url_rules() {
        assert!(ServerUrl::parse("http://example.com").is_err());
        assert!(ServerUrl::parse("ftp://example.com").is_err());
        assert!(ServerUrl::parse("https://example.com/?x=1").is_err());
        assert!(ServerUrl::parse("https://user:pw@example.com").is_err());
        let local = ServerUrl::parse("http://localhost:5173").unwrap();
        assert_eq!(local.ws_url("/s"), "ws://localhost:5173/s");
        let v6 = ServerUrl::parse("http://[::1]:5173").unwrap();
        assert_eq!(v6.host(), "::1");
        assert_eq!(ServerUrl::parse("https://h").unwrap().port(), 443);
    }

    #[test]
    fn replies_and_refusals() {
        let ok: Reply<CheckInReply> =
            parse_reply(200, r#"{"checkInSeconds":30,"inventoryWanted":false}"#).unwrap();
        assert!(matches!(ok, Reply::Ok(r) if r.check_in_seconds == 30));
        let refused: Reply<CheckInReply> =
            parse_reply(401, r#"{"reason":"revoked","message":"Removed."}"#).unwrap();
        assert!(matches!(refused, Reply::Refused(r) if r.reason == RefusalReason::Revoked));
        assert!(parse_reply::<CheckInReply>(500, "boom").is_err());
        assert!(parse_reply::<CheckInReply>(401, "nope").is_err());
    }

    fn session() -> Session {
        let transport = Transport::new(
            ServerUrl::parse("https://example.com").unwrap(),
            Security::once(TlsMode::Checked(ServerTrust::Public)),
        );
        Session::new(transport, "m".into(), SigningKey::from_bytes(&[1; 32]))
    }

    #[test]
    fn timestamps_always_increase() {
        let s = session();
        let a = s.next_timestamp();
        let b = s.next_timestamp();
        assert!(b > a);
    }

    #[test]
    fn clock_follows_server_date() {
        let s = session();
        let ahead = SystemTime::now() + Duration::from_secs(600);
        s.observe_date(Some(&httpdate::fmt_http_date(ahead)));
        let offset = lock(&s.clock).offset_ms;
        assert!((offset - 600_000).abs() < 2_000, "offset {offset}");

        // Back to the right time: timestamps drop back too.
        s.observe_date(Some(&httpdate::fmt_http_date(SystemTime::now())));
        let now = local_now_ms();
        let next = s.next_timestamp();
        assert!((next - now).abs() < 2_000, "next {next} now {now}");
    }
}
