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

/// First line of every signed message; bump it if the message format changes.
pub const SIGNING_DOMAIN: &str = "BMUSTER-REQ-1";

/// Scheme name in the `Authorization` header.
pub const AUTH_SCHEME: &str = "BMuster";

pub const ENROL_PATH: &str = "/agent/v1/enrol";
pub const CHECK_IN_PATH: &str = "/agent/v1/check-in";
pub const SOCKET_PATH: &str = "/agent/v1/socket";

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
pub struct CheckInReply {
    pub check_in_seconds: u32,
    /// The server has no inventory for this machine; send it in full next time.
    pub inventory_wanted: bool,
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
                inventory_wanted: true
            }
        );
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
}
