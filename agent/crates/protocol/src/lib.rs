//! Wire types and request signing shared by the BMuster agent and server.
//!
//! The contract is `docs/specs/SPEC-ENROLMENT.md` (Sections 6 to 8). JSON is
//! camelCase; "maybe" values are tagged unions with a `kind` (or `type` on the
//! live socket) field, never optional properties.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;

mod display;
pub mod files;
pub mod logs;
pub mod session;
mod updates;
pub use display::{
    DisplayReport, DrmCard, DrmConnector, LauncherVersion, LinuxDisplay, LockedHint, NvidiaModeset,
    Programs, SeLinux, SeatSession, Uinput,
};
pub use updates::{
    release_message, release_message_of, release_path, AgentVersion, UpdateEvent, UpdateOffer,
    UpdateReport, VersionError, RELEASE_SIGNING_DOMAIN,
};

/// First line of every signed message; bump it if the message format changes.
pub const SIGNING_DOMAIN: &str = "BMUSTER-REQ-1";

/// Scheme name in the `Authorization` header.
pub const AUTH_SCHEME: &str = "BMuster";

pub const ENROL_PATH: &str = "/agent/v1/enrol";
pub const CHECK_IN_PATH: &str = "/agent/v1/check-in";
pub const SOCKET_PATH: &str = "/agent/v1/socket";
/// The agent leaves this server: it moved to another one, or was uninstalled.
pub const LEAVE_PATH: &str = "/agent/v1/leave";
/// The local page's sign-in secret and certificate (SPEC-AGENT-LOCAL).
pub const LOCAL_PAGE_PATH: &str = "/agent/v1/local-page";
/// What happened on the local page, queued while offline (SPEC-AGENT-LOCAL 7).
pub const LOCAL_EVENTS_PATH: &str = "/agent/v1/local-events";

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

/// Lower-case hex SHA-256 of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// The exact text an agent signs for one request.
///
/// `path` is the URL path only, without the query string, exactly as sent.
pub fn signing_message(method: &str, path: &str, timestamp_ms: i64, body: &[u8]) -> String {
    format!(
        "{SIGNING_DOMAIN}\n{method}\n{path}\n{timestamp_ms}\n{}",
        sha256_hex(body)
    )
}

/// Ed25519 signature over [`signing_message`].
pub fn sign_request(
    key: &SigningKey,
    method: &str,
    path: &str,
    timestamp_ms: i64,
    body: &[u8],
) -> Signature {
    key.sign(signing_message(method, path, timestamp_ms, body).as_bytes())
}

/// `BMuster <machineId>:<timestampMs>:<base64 signature>`.
pub fn authorization_header(machine_id: &str, timestamp_ms: i64, signature: &Signature) -> String {
    format!(
        "{AUTH_SCHEME} {machine_id}:{timestamp_ms}:{}",
        BASE64.encode(signature.to_bytes())
    )
}

/// Standard base64 (with padding) of the raw 32-byte public key.
pub fn encode_public_key(key: &VerifyingKey) -> String {
    BASE64.encode(key.as_bytes())
}

/// Why a base64 public key could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyError {
    NotBase64,
    WrongLength(usize),
    NotAPoint,
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeyError::NotBase64 => write!(f, "the public key is not standard base64"),
            KeyError::WrongLength(n) => {
                write!(f, "the public key is {n} bytes long; Ed25519 keys are 32")
            }
            KeyError::NotAPoint => write!(f, "the public key is not a valid Ed25519 key"),
        }
    }
}

impl std::error::Error for KeyError {}

/// Reads a public key written by [`encode_public_key`].
pub fn decode_public_key(text: &str) -> Result<VerifyingKey, KeyError> {
    let bytes = BASE64.decode(text).map_err(|_| KeyError::NotBase64)?;
    let raw: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| KeyError::WrongLength(bytes.len()))?;
    VerifyingKey::from_bytes(&raw).map_err(|_| KeyError::NotAPoint)
}

// ---------------------------------------------------------------------------
// Certificate pins (SPEC-INSTALL-OPTIONS L5, L7)
// ---------------------------------------------------------------------------

/// A server certificate pin: the SHA-256 of the certificate's DER
/// SubjectPublicKeyInfo, written `sha256:<standard base64>`. The same value
/// curl's `--pinnedpubkey sha256//<base64>` checks.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct CertificatePin([u8; 32]);

const PIN_PREFIX: &str = "sha256:";

/// Why a pin could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PinError {
    MissingPrefix,
    NotBase64,
    WrongLength(usize),
}

impl fmt::Display for PinError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PinError::MissingPrefix => write!(f, "a certificate pin starts with sha256:"),
            PinError::NotBase64 => write!(f, "the certificate pin is not standard base64"),
            PinError::WrongLength(n) => {
                write!(f, "the certificate pin is {n} bytes long; a SHA-256 is 32")
            }
        }
    }
}

impl std::error::Error for PinError {}

impl CertificatePin {
    /// The pin of a DER-encoded SubjectPublicKeyInfo.
    pub fn of_public_key_info(spki_der: &[u8]) -> Self {
        Self(Sha256::digest(spki_der).into())
    }

    pub fn parse(text: &str) -> Result<Self, PinError> {
        let encoded = text
            .trim()
            .strip_prefix(PIN_PREFIX)
            .ok_or(PinError::MissingPrefix)?;
        let bytes = BASE64.decode(encoded).map_err(|_| PinError::NotBase64)?;
        let raw: [u8; 32] = bytes
            .as_slice()
            .try_into()
            .map_err(|_| PinError::WrongLength(bytes.len()))?;
        Ok(Self(raw))
    }
}

impl fmt::Display for CertificatePin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{PIN_PREFIX}{}", BASE64.encode(self.0))
    }
}

impl fmt::Debug for CertificatePin {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl std::str::FromStr for CertificatePin {
    type Err = PinError;

    fn from_str(text: &str) -> Result<Self, Self::Err> {
        Self::parse(text)
    }
}

impl Serialize for CertificatePin {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for CertificatePin {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Self::parse(&text).map_err(serde::de::Error::custom)
    }
}

/// How the agent checks the server's certificate: the operating system's
/// trust store, or exactly one pinned public key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ServerTrust {
    Public,
    Pin { pin: CertificatePin },
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/// Machine-readable reason in a refusal body.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RefusalReason {
    BadRequest,
    InvalidCode,
    ExpiredCode,
    UsedCode,
    BadSignature,
    StaleTimestamp,
    ReplayedTimestamp,
    UnknownMachine,
    Revoked,
}

impl RefusalReason {
    pub fn as_str(self) -> &'static str {
        match self {
            RefusalReason::BadRequest => "bad-request",
            RefusalReason::InvalidCode => "invalid-code",
            RefusalReason::ExpiredCode => "expired-code",
            RefusalReason::UsedCode => "used-code",
            RefusalReason::BadSignature => "bad-signature",
            RefusalReason::StaleTimestamp => "stale-timestamp",
            RefusalReason::ReplayedTimestamp => "replayed-timestamp",
            RefusalReason::UnknownMachine => "unknown-machine",
            RefusalReason::Revoked => "revoked",
        }
    }
}

impl fmt::Display for RefusalReason {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Body of an HTTP 400, 401, 404 or 409 reply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Refusal {
    pub reason: RefusalReason,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrolRequest {
    pub code: String,
    pub public_key: String,
    pub hostname: String,
    pub name: String,
    pub os_family: String,
    pub target: String,
    pub agent_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrolReply {
    pub machine_id: String,
    pub server_public_key: String,
    pub check_in_seconds: u32,
}

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInRequest {
    pub agent_version: String,
    pub uptime_seconds: u64,
    pub signed_in_user: SignedInUser,
    pub load: Load,
    pub inventory: InventoryReport,
    /// The list of people who may sign in to the local page that the agent
    /// holds (SPEC-AGENT-LOCAL 7). Older agents send none.
    pub local_users: LocalUsersHeld,
    /// Whether this agent can update itself, and its last update (SPEC-AGENT-UPDATES).
    pub update: UpdateReport,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum SignedInUser {
    None,
    User { name: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Load {
    /// 0 to 100.
    pub cpu_percent: f32,
    pub memory_used_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum InventoryReport {
    Unchanged { hash: String },
    Full { hash: String, data: Box<Inventory> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub os: OsInfo,
    pub hostname: String,
    pub cpu: CpuInfo,
    pub memory_total_bytes: u64,
    pub disks: Vec<DiskInfo>,
    pub displays: Vec<DisplayInfo>,
    pub network: Vec<NetworkInterface>,
    /// Every graphics card, integrated and discrete (SPEC-MACHINE-DETAILS D8).
    pub gpus: Vec<GpuInfo>,
    /// What a remote desktop depends on (SPEC-AGENT-LOGS 3).
    pub display: DisplayReport,
}

impl Inventory {
    /// Lower-case hex SHA-256 of this inventory's JSON. Field order is fixed by
    /// the struct, so equal inventories always hash the same.
    pub fn hash(&self) -> Result<String, serde_json::Error> {
        Ok(sha256_hex(&serde_json::to_vec(self)?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OsInfo {
    /// `linux`, `windows` or `macos`.
    pub family: String,
    pub name: String,
    pub version: String,
    /// Kernel or build number; empty when the system does not report one.
    pub build: String,
    pub updates_pending: UpdatesPending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UpdatesPending {
    Unknown,
    Known { count: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuInfo {
    pub model: String,
    /// Logical processors.
    pub cores: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub mount: String,
    pub size_bytes: u64,
    pub used_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayInfo {
    pub index: u32,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInterface {
    pub name: String,
    pub mac: String,
    /// Plain IP addresses, without prefix length.
    pub addresses: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    /// What people call it, e.g. `NVIDIA GeForce RTX 4070`.
    pub name: String,
    /// The maker, e.g. `NVIDIA Corporation`.
    pub vendor: String,
    pub memory_bytes: GpuMemory,
    /// Driver name and version where known; empty when the system does not say.
    pub driver: String,
}

/// Dedicated video memory. Integrated graphics share main memory: `Unknown`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum GpuMemory {
    Unknown,
    Known { bytes: u64 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInReply {
    pub check_in_seconds: u32,
    /// The server has no inventory for this machine; send it in full next time.
    pub inventory_wanted: bool,
    /// The machine's name in the console (shown on the local page). Empty
    /// from servers older than SPEC-AGENT-LOCAL.
    #[serde(default)]
    pub machine_name: String,
    /// A new list of people for the local page, or `Unchanged` (also from
    /// servers older than SPEC-AGENT-LOCAL 7).
    #[serde(default)]
    pub local_users: LocalUsersUpdate,
    /// A newer signed build to install; none from servers before SPEC-AGENT-UPDATES.
    #[serde(default)]
    pub update: UpdateOffer,
}

// ---------------------------------------------------------------------------
// Leaving a server and the local page (SPEC-AGENT-LOCAL)
// ---------------------------------------------------------------------------

/// Why the agent leaves its server.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LeaveReason {
    /// It enrolled with another server (local page or `rejoin`).
    Moved,
    /// It is being uninstalled from the local page.
    Uninstalled,
}

/// `POST /agent/v1/leave`, signed. The server refuses the machine from then on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaveRequest {
    pub reason: LeaveReason,
}

/// `POST /agent/v1/local-page`, signed: what the console needs to show the
/// local page's sign-in code and certificate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPageReport {
    /// The 20-byte TOTP secret (RFC 6238, SHA-1, 6 digits, 30 s), standard base64.
    pub totp_secret: String,
    /// SHA-256 of the page's certificate (DER), lower-case hex.
    pub certificate_sha256: String,
    /// The port the page listens on.
    pub port: u16,
}

// ---------------------------------------------------------------------------
// Per-person local page codes and local events (SPEC-AGENT-LOCAL 7)
// ---------------------------------------------------------------------------

/// Someone who may sign in to the local page with their own code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalUser {
    pub user_id: String,
    pub name: String,
}

/// What the agent holds, in each check-in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LocalUsersHeld {
    None,
    /// The `hash` the server sent with the list, as it was sent.
    Held {
        hash: String,
    },
}

/// What the check-in reply says about the list.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LocalUsersUpdate {
    #[default]
    Unchanged,
    List {
        hash: String,
        users: Vec<LocalUser>,
    },
}

/// Whose code a local page session signed in with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CodeOwners {
    /// The shared machine code (no list held yet).
    Machine,
    /// Usually one person; more only if several codes matched at once.
    People { people: Vec<LocalUser> },
}

/// Something that happened on the local page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LocalEvent {
    SignedIn {
        codes: CodeOwners,
    },
    SignedOut {
        codes: CodeOwners,
    },
    SessionExpired {
        codes: CodeOwners,
    },
    WrongCode,
    /// The fifth wrong code in a row: sign-in paused for 5 minutes.
    LockedOut,
    Restarted {
        codes: CodeOwners,
    },
    ConnectionTested {
        codes: CodeOwners,
        passed: bool,
    },
    #[serde(rename_all = "camelCase")]
    MoveStarted {
        codes: CodeOwners,
        server_url: String,
    },
    #[serde(rename_all = "camelCase")]
    MoveFinished {
        codes: CodeOwners,
        server_url: String,
    },
    MoveFailed {
        codes: CodeOwners,
        reason: String,
    },
    /// Just before the signed `leave` of a move or uninstall.
    Leaving {
        codes: CodeOwners,
        reason: LeaveReason,
    },
    Uninstalled {
        codes: CodeOwners,
    },
    /// The queue was full: this many older events were dropped.
    Dropped {
        count: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEventEntry {
    /// Increases with every event this agent records.
    pub seq: u64,
    /// When it happened, Unix milliseconds.
    pub at_ms: u64,
    pub event: LocalEvent,
}

/// `POST /agent/v1/local-events`, signed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalEventsReport {
    pub sent_at_ms: u64,
    pub events: Vec<LocalEventEntry>,
}

// ---------------------------------------------------------------------------
// Live socket
// ---------------------------------------------------------------------------

/// Server to agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerMessage {
    CheckInNow,
    Watch {
        #[serde(rename = "intervalMs")]
        interval_ms: u64,
    },
    Unwatch,
    /// The certificate the server serves after its next restart (L7).
    PinUpdate {
        next: ServerTrust,
    },
    /// Start a session (SPEC-SESSIONS): a signed ticket, see [`session`].
    SessionOpen {
        ticket: String,
        signature: String,
    },
    /// A message box on the console session's screen from `from`, a
    /// console user (Windows only for now).
    UserMessage {
        from: String,
        text: String,
    },
    /// The server stored this instance's records up to `seq` (SPEC-AGENT-LOGS 1).
    LogAck {
        instance: String,
        seq: u64,
    },
    /// Log the agent's own debug records until a time, or go back to info.
    LogLevel(logs::VerboseLevel),
}

/// Agent to server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum AgentMessage {
    Live {
        #[serde(rename = "cpuPercent")]
        cpu_percent: f32,
        #[serde(rename = "memoryUsedBytes")]
        memory_used_bytes: u64,
    },
    /// A `session-open` this agent would not start, and why.
    SessionRefused {
        #[serde(rename = "sessionId")]
        session_id: String,
        message: String,
    },
    /// Log records from one agent process, oldest first (SPEC-AGENT-LOGS 1).
    LogBatch {
        instance: String,
        records: Vec<logs::LogRecord>,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tagged_unions_match_the_spec_shapes() {
        assert_eq!(
            serde_json::to_value(SignedInUser::None).unwrap(),
            json!({ "kind": "none" })
        );
        assert_eq!(
            serde_json::to_value(SignedInUser::User { name: "kim".into() }).unwrap(),
            json!({ "kind": "user", "name": "kim" })
        );
        assert_eq!(
            serde_json::to_value(UpdatesPending::Known { count: 3 }).unwrap(),
            json!({ "kind": "known", "count": 3 })
        );
        assert_eq!(
            serde_json::to_value(GpuInfo {
                name: "NVIDIA GeForce RTX 4070".into(),
                vendor: "NVIDIA Corporation".into(),
                memory_bytes: GpuMemory::Known { bytes: 12 << 30 },
                driver: "nvidia 550.54".into(),
            })
            .unwrap(),
            json!({
                "name": "NVIDIA GeForce RTX 4070",
                "vendor": "NVIDIA Corporation",
                "memoryBytes": { "kind": "known", "bytes": 12_u64 << 30 },
                "driver": "nvidia 550.54"
            })
        );
        assert_eq!(
            serde_json::to_value(GpuMemory::Unknown).unwrap(),
            json!({ "kind": "unknown" })
        );
        assert_eq!(
            serde_json::to_value(InventoryReport::Unchanged { hash: "ab".into() }).unwrap(),
            json!({ "kind": "unchanged", "hash": "ab" })
        );
        assert_eq!(
            serde_json::from_value::<ServerMessage>(json!({ "type": "watch", "intervalMs": 2000 }))
                .unwrap(),
            ServerMessage::Watch { interval_ms: 2000 }
        );
        assert_eq!(
            serde_json::from_value::<ServerMessage>(json!({ "type": "check-in-now" })).unwrap(),
            ServerMessage::CheckInNow
        );
        assert_eq!(
            serde_json::to_value(AgentMessage::Live {
                cpu_percent: 12.5,
                memory_used_bytes: 1024
            })
            .unwrap(),
            json!({ "type": "live", "cpuPercent": 12.5, "memoryUsedBytes": 1024 })
        );
        assert_eq!(
            serde_json::from_value::<Refusal>(
                json!({ "reason": "revoked", "message": "This machine was removed." })
            )
            .unwrap()
            .reason,
            RefusalReason::Revoked
        );
        assert_eq!(
            serde_json::from_value::<CheckInReply>(
                json!({ "checkInSeconds": 60, "inventoryWanted": true })
            )
            .unwrap(),
            CheckInReply {
                check_in_seconds: 60,
                inventory_wanted: true,
                machine_name: String::new(),
                local_users: LocalUsersUpdate::Unchanged,
                update: UpdateOffer::None
            }
        );
        assert_eq!(
            serde_json::to_value(LeaveRequest {
                reason: LeaveReason::Moved
            })
            .unwrap(),
            json!({ "reason": "moved" })
        );
        assert_eq!(
            serde_json::to_value(LeaveRequest {
                reason: LeaveReason::Uninstalled
            })
            .unwrap(),
            json!({ "reason": "uninstalled" })
        );
        assert_eq!(
            serde_json::to_value(LocalPageReport {
                totp_secret: "AAAA".into(),
                certificate_sha256: "ab".into(),
                port: 47500
            })
            .unwrap(),
            json!({ "totpSecret": "AAAA", "certificateSha256": "ab", "port": 47500 })
        );
    }

    #[test]
    fn local_users_and_events_match_the_spec_shapes() {
        assert_eq!(
            serde_json::to_value(LocalUsersHeld::Held { hash: "ab".into() }).unwrap(),
            json!({ "kind": "held", "hash": "ab" })
        );
        assert_eq!(
            serde_json::from_value::<LocalUsersUpdate>(json!({
                "kind": "list",
                "hash": "ab",
                "users": [{ "userId": "u1", "name": "Jack Brumley" }]
            }))
            .unwrap(),
            LocalUsersUpdate::List {
                hash: "ab".into(),
                users: vec![LocalUser {
                    user_id: "u1".into(),
                    name: "Jack Brumley".into()
                }]
            }
        );
        assert_eq!(
            serde_json::to_value(LocalEventEntry {
                seq: 7,
                at_ms: 1000,
                event: LocalEvent::MoveStarted {
                    codes: CodeOwners::Machine,
                    server_url: "https://new.example".into()
                }
            })
            .unwrap(),
            json!({
                "seq": 7,
                "atMs": 1000,
                "event": {
                    "kind": "move-started",
                    "codes": { "kind": "machine" },
                    "serverUrl": "https://new.example"
                }
            })
        );
        assert_eq!(
            serde_json::to_value(LocalEvent::Leaving {
                codes: CodeOwners::People { people: vec![] },
                reason: LeaveReason::Uninstalled
            })
            .unwrap(),
            json!({
                "kind": "leaving",
                "codes": { "kind": "people", "people": [] },
                "reason": "uninstalled"
            })
        );
    }

    #[test]
    fn pins_parse_print_and_travel_as_the_server_sends_them() {
        // sha256 of the empty input, in base64.
        let text = "sha256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=";
        let pin = CertificatePin::parse(text).unwrap();
        assert_eq!(pin, CertificatePin::of_public_key_info(b""));
        assert_eq!(pin.to_string(), text);
        assert_eq!(CertificatePin::parse(&format!(" {text}\n")).unwrap(), pin);
        assert_eq!(
            CertificatePin::parse("47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="),
            Err(PinError::MissingPrefix)
        );
        assert_eq!(
            CertificatePin::parse("sha256//47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="),
            Err(PinError::MissingPrefix)
        );
        assert_eq!(
            CertificatePin::parse("sha256:not base64!"),
            Err(PinError::NotBase64)
        );
        assert_eq!(
            CertificatePin::parse("sha256:AAAA"),
            Err(PinError::WrongLength(3))
        );

        assert_eq!(
            serde_json::from_value::<ServerMessage>(json!({
                "type": "pin-update",
                "next": { "kind": "pin", "pin": text }
            }))
            .unwrap(),
            ServerMessage::PinUpdate {
                next: ServerTrust::Pin { pin }
            }
        );
        assert_eq!(
            serde_json::from_value::<ServerMessage>(
                json!({ "type": "pin-update", "next": { "kind": "public" } })
            )
            .unwrap(),
            ServerMessage::PinUpdate {
                next: ServerTrust::Public
            }
        );
        assert!(serde_json::from_value::<ServerMessage>(json!({
            "type": "pin-update",
            "next": { "kind": "pin", "pin": "sha256:AAAA" }
        }))
        .is_err());
    }

    #[test]
    fn refusal_reason_text_matches_serde() {
        for reason in [
            RefusalReason::BadRequest,
            RefusalReason::InvalidCode,
            RefusalReason::ExpiredCode,
            RefusalReason::UsedCode,
            RefusalReason::BadSignature,
            RefusalReason::StaleTimestamp,
            RefusalReason::ReplayedTimestamp,
            RefusalReason::UnknownMachine,
            RefusalReason::Revoked,
        ] {
            assert_eq!(
                serde_json::to_value(reason).unwrap(),
                json!(reason.as_str())
            );
        }
    }

    #[test]
    fn public_key_round_trips_and_rejects_bad_input() {
        let key = SigningKey::from_bytes(&[7; 32]).verifying_key();
        let text = encode_public_key(&key);
        assert_eq!(text.len(), 44);
        assert_eq!(decode_public_key(&text).unwrap(), key);
        assert_eq!(decode_public_key("not base64!"), Err(KeyError::NotBase64));
        assert_eq!(decode_public_key("AAAA"), Err(KeyError::WrongLength(3)));
    }

    #[test]
    fn a_user_message_reads_from_the_server() {
        let message: ServerMessage = serde_json::from_str(
            r#"{"type":"user-message","from":"Jack","text":"Rebooting at 5"}"#,
        )
        .unwrap();
        assert_eq!(
            message,
            ServerMessage::UserMessage {
                from: "Jack".into(),
                text: "Rebooting at 5".into()
            }
        );
    }

    #[test]
    fn log_messages_match_the_agent_socket_contract() {
        assert_eq!(
            serde_json::to_value(AgentMessage::LogBatch {
                instance: "11111111-1111-4111-8111-111111111111".into(),
                records: vec![logs::LogRecord {
                    seq: 1,
                    at: 1_000,
                    level: logs::LogLevel::Warn,
                    source: logs::LogSource::Helper,
                    target: "wayland-helper".into(),
                    text: "pipewire stream failed".into(),
                }],
            })
            .unwrap(),
            json!({
                "type": "log-batch",
                "instance": "11111111-1111-4111-8111-111111111111",
                "records": [{
                    "seq": 1, "at": 1_000, "level": "warn", "source": "helper",
                    "target": "wayland-helper", "text": "pipewire stream failed"
                }]
            })
        );
        let ack: ServerMessage =
            serde_json::from_str(r#"{"type":"log-ack","instance":"i-1","seq":42}"#).unwrap();
        assert_eq!(
            ack,
            ServerMessage::LogAck {
                instance: "i-1".into(),
                seq: 42
            }
        );
        let debug: ServerMessage =
            serde_json::from_str(r#"{"type":"log-level","level":"debug","untilMs":5000}"#).unwrap();
        assert_eq!(
            debug,
            ServerMessage::LogLevel(logs::VerboseLevel::Debug { until_ms: 5000 })
        );
        let info: ServerMessage =
            serde_json::from_str(r#"{"type":"log-level","level":"info"}"#).unwrap();
        assert_eq!(info, ServerMessage::LogLevel(logs::VerboseLevel::Info));
    }

    #[test]
    fn display_report_matches_the_inventory_contract() {
        let report = DisplayReport::Linux(Box::new(LinuxDisplay {
            seat: SeatSession::Active {
                session_type: "wayland".into(),
                class: "user".into(),
                desktop: "GNOME".into(),
                state: "active".into(),
                locked_hint: LockedHint::Unknown,
            },
            cards: vec![DrmCard {
                name: "card1".into(),
                driver: "i915".into(),
                kms: true,
                connectors: vec![DrmConnector {
                    name: "eDP-1".into(),
                    modes: vec!["1920x1080".into()],
                }],
            }],
            uinput: Uinput {
                device: true,
                module: true,
            },
            nvidia_modeset: NvidiaModeset::Absent,
            programs: Programs {
                xdg_desktop_portal: true,
                gstreamer: true,
                pipewiresrc: false,
            },
            kernel: "6.17.1".into(),
            agent_version: "0.4.0".into(),
            launcher_version: LauncherVersion::Known {
                version: "0.4.0".into(),
            },
            selinux: SeLinux::Present {
                enforcing: true,
                agent_context: "system_u:system_r:unconfined_service_t:s0".into(),
                init_context: "system_u:system_r:init_t:s0".into(),
            },
        }));
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            json!({
                "kind": "linux",
                "seat": {
                    "kind": "active", "sessionType": "wayland", "class": "user",
                    "desktop": "GNOME", "state": "active", "lockedHint": { "kind": "unknown" }
                },
                "cards": [{
                    "name": "card1", "driver": "i915", "kms": true,
                    "connectors": [{ "name": "eDP-1", "modes": ["1920x1080"] }]
                }],
                "uinput": { "device": true, "module": true },
                "nvidiaModeset": { "kind": "absent" },
                "programs": { "xdgDesktopPortal": true, "gstreamer": true, "pipewiresrc": false },
                "kernel": "6.17.1",
                "agentVersion": "0.4.0",
                "launcherVersion": { "kind": "known", "version": "0.4.0" },
                "selinux": {
                    "kind": "present", "enforcing": true,
                    "agentContext": "system_u:system_r:unconfined_service_t:s0",
                    "initContext": "system_u:system_r:init_t:s0"
                }
            })
        );
        assert_eq!(
            serde_json::to_value(DisplayReport::Windows {
                console: SignedInUser::None
            })
            .unwrap(),
            json!({ "kind": "windows", "console": { "kind": "none" } })
        );
    }
}
