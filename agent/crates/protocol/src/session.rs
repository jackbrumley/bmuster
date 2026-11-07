//! Remote sessions (`docs/specs/SPEC-SESSIONS.md`): the ticket the server
//! signs for each session, and the messages on a session's own socket.
//!
//! A session starts with `session-open` on the live socket, carrying a ticket
//! (JSON, base64) and the server's Ed25519 signature over
//! `BMUSTER-TICKET-1\n` followed by the ticket's exact bytes. The agent checks
//! it against the server key it stored at enrolment, then opens a signed
//! WebSocket at [`session_socket_path`]. On that socket binary frames carry
//! the session's bytes and text frames carry JSON control messages. Terminal,
//! exec and file sessions share the ticket and the socket; only the
//! ticket's `purpose` and the meaning of the frames differ.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::fmt;

/// First line of every signed ticket; bump it if the ticket format changes.
pub const TICKET_DOMAIN: &str = "BMUSTER-TICKET-1";

/// A ticket lives this long at most (the server gives it 60 s).
pub const TICKET_MAX_LIFETIME_MS: i64 = 120_000;

/// Allowed difference between the agent's corrected clock and the server's.
pub const TICKET_CLOCK_GRACE_MS: i64 = 5_000;

/// The path of a session's own socket. Signed like any agent request.
pub fn session_socket_path(session_id: &str) -> String {
    format!("/agent/v1/sessions/{session_id}")
}

/// The exact bytes the server signs for a ticket.
pub fn ticket_message(ticket_json: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(TICKET_DOMAIN.len() + 1 + ticket_json.len());
    message.extend_from_slice(TICKET_DOMAIN.as_bytes());
    message.push(b'\n');
    message.extend_from_slice(ticket_json);
    message
}

/// What the server allows one session to do. Unknown fields are refused: a
/// field this agent does not understand might be a restriction it would
/// otherwise ignore.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionTicket {
    pub session_id: String,
    pub machine_id: String,
    pub user: TicketUser,
    /// The person's permissions on this machine (SPEC-ACCESS), e.g. `terminal`.
    pub permissions: Vec<String>,
    pub run_as: RunAs,
    pub issued_at_ms: i64,
    pub expires_at_ms: i64,
    pub purpose: SessionPurpose,
}

/// The console user the session is for (shown on the machine, never trusted
/// for access: the permissions are).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TicketUser {
    pub id: String,
    pub name: String,
}

/// Which account the session's processes run as. Only the agent's own
/// account (root or SYSTEM) for now; the signed-in user comes later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum RunAs {
    Admin,
}

/// A shell the agent can start. The agent resolves it to a program.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Shell {
    Bash,
    Sh,
    Zsh,
    Powershell,
    Cmd,
}

impl Shell {
    pub fn as_str(self) -> &'static str {
        match self {
            Shell::Bash => "bash",
            Shell::Sh => "sh",
            Shell::Zsh => "zsh",
            Shell::Powershell => "powershell",
            Shell::Cmd => "cmd",
        }
    }
}

/// What the session is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum SessionPurpose {
    /// An interactive shell on a pseudo-terminal of this size.
    Terminal { shell: Shell, cols: u16, rows: u16 },
    /// One command, no input, output capped (the MCP `run_command` tool).
    Exec {
        shell: Shell,
        command: String,
        timeout_ms: u64,
        max_output_bytes: u64,
    },
    /// File actions (SPEC-FILES): the server sends requests on the session
    /// socket ([`crate::files`]); nothing runs until it asks. A struct
    /// variant, so a field this agent does not know is refused.
    Files {},
}

impl SessionPurpose {
    /// The permission a ticket must carry for this purpose.
    pub fn required_permission(&self) -> &'static str {
        match self {
            SessionPurpose::Terminal { .. } => "terminal",
            SessionPurpose::Exec { .. } => "ai-commands",
            SessionPurpose::Files {} => "files",
        }
    }
}

/// Why a ticket was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TicketError {
    NotBase64,
    BadSignature,
    NotATicket(String),
    WrongMachine,
    Expired,
    NotYetValid,
    TooLong,
    MissingPermission(&'static str),
    Replayed,
}

impl fmt::Display for TicketError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TicketError::NotBase64 => write!(f, "the ticket or its signature is not base64"),
            TicketError::BadSignature => {
                write!(f, "the ticket is not signed by this agent's server")
            }
            TicketError::NotATicket(why) => write!(f, "the ticket cannot be read: {why}"),
            TicketError::WrongMachine => write!(f, "the ticket is for another machine"),
            TicketError::Expired => write!(f, "the ticket has expired"),
            TicketError::NotYetValid => write!(f, "the ticket was issued in the future"),
            TicketError::TooLong => write!(f, "the ticket lives longer than allowed"),
            TicketError::MissingPermission(permission) => {
                write!(f, "the ticket does not carry the {permission} permission")
            }
            TicketError::Replayed => write!(f, "the ticket was already used"),
        }
    }
}

impl std::error::Error for TicketError {}

/// Checks a ticket from `session-open`: the server's signature first, then
/// the machine, the time window and the permission its purpose needs.
/// `now_ms` is the agent's clock corrected to the server's. Replays are the
/// caller's to refuse (it remembers the session ids it has seen).
pub fn open_ticket(
    server_key: &VerifyingKey,
    ticket_base64: &str,
    signature_base64: &str,
    machine_id: &str,
    now_ms: i64,
) -> Result<SessionTicket, TicketError> {
    let json = BASE64
        .decode(ticket_base64)
        .map_err(|_| TicketError::NotBase64)?;
    let raw = BASE64
        .decode(signature_base64)
        .map_err(|_| TicketError::NotBase64)?;
    let raw: [u8; 64] = raw
        .as_slice()
        .try_into()
        .map_err(|_| TicketError::BadSignature)?;
    server_key
        .verify_strict(&ticket_message(&json), &Signature::from_bytes(&raw))
        .map_err(|_| TicketError::BadSignature)?;
    let ticket: SessionTicket =
        serde_json::from_slice(&json).map_err(|e| TicketError::NotATicket(e.to_string()))?;
    if ticket.machine_id != machine_id {
        return Err(TicketError::WrongMachine);
    }
    if ticket.expires_at_ms - ticket.issued_at_ms > TICKET_MAX_LIFETIME_MS {
        return Err(TicketError::TooLong);
    }
    if ticket.issued_at_ms > now_ms + TICKET_CLOCK_GRACE_MS {
        return Err(TicketError::NotYetValid);
    }
    if now_ms > ticket.expires_at_ms + TICKET_CLOCK_GRACE_MS {
        return Err(TicketError::Expired);
    }
    let needed = ticket.purpose.required_permission();
    if !ticket.permissions.iter().any(|held| held == needed) {
        return Err(TicketError::MissingPermission(needed));
    }
    Ok(ticket)
}

/// Server to agent on a session socket (text frames).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SessionControl {
    /// The browser's terminal changed size.
    Resize { cols: u16, rows: u16 },
}

/// Agent to server on a session socket (text frames). The agent sends one
/// of these last, then closes the socket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SessionEvent {
    /// The shell ended: its exit code, or 128 + the signal that ended it.
    Exited { code: i32 },
    /// The session could not start or broke; the message is for the console.
    Failed { message: String },
    /// An exec command finished. `exit_code` is -1 when it was killed.
    ExecDone {
        exit_code: i32,
        duration_ms: u64,
        truncated: bool,
        timed_out: bool,
    },
}

/// First byte of an exec output frame: which stream the rest came from.
pub const EXEC_STDOUT: u8 = 1;
pub const EXEC_STDERR: u8 = 2;

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer as _, SigningKey};
    use serde_json::json;

    const MACHINE: &str = "3f0c2a8e-8a8e-4c55-9d3c-2a4f1c1d7e10";
    const NOW: i64 = 1_794_000_000_000;

    fn ticket_json(overrides: serde_json::Value) -> serde_json::Value {
        let mut ticket = json!({
            "sessionId": "5b8f9c1e-1d2a-4c3b-8e7f-0a1b2c3d4e5f",
            "machineId": MACHINE,
            "user": { "id": "u1", "name": "Jack" },
            "permissions": ["view", "terminal"],
            "runAs": { "kind": "admin" },
            "issuedAtMs": NOW,
            "expiresAtMs": NOW + 60_000,
            "purpose": { "kind": "terminal", "shell": "bash", "cols": 80, "rows": 24 }
        });
        if let (Some(base), Some(extra)) = (ticket.as_object_mut(), overrides.as_object()) {
            for (key, value) in extra {
                base.insert(key.clone(), value.clone());
            }
        }
        ticket
    }

    fn signed(key: &SigningKey, ticket: &serde_json::Value) -> (String, String) {
        let bytes = serde_json::to_vec(ticket).unwrap();
        let signature = key.sign(&ticket_message(&bytes));
        (BASE64.encode(&bytes), BASE64.encode(signature.to_bytes()))
    }

    fn open(
        key: &SigningKey,
        ticket: &serde_json::Value,
        now: i64,
    ) -> Result<SessionTicket, TicketError> {
        let (text, signature) = signed(key, ticket);
        open_ticket(&key.verifying_key(), &text, &signature, MACHINE, now)
    }

    #[test]
    fn a_good_ticket_opens() {
        let key = SigningKey::from_bytes(&[9; 32]);
        let ticket = open(&key, &ticket_json(json!({})), NOW + 1_000).unwrap();
        assert_eq!(
            ticket.purpose,
            SessionPurpose::Terminal {
                shell: Shell::Bash,
                cols: 80,
                rows: 24
            }
        );
        assert_eq!(ticket.run_as, RunAs::Admin);
        assert_eq!(ticket.user.name, "Jack");
    }

    #[test]
    fn tickets_signed_by_another_key_are_refused() {
        let server = SigningKey::from_bytes(&[9; 32]);
        let other = SigningKey::from_bytes(&[8; 32]);
        let (text, signature) = signed(&other, &ticket_json(json!({})));
        assert_eq!(
            open_ticket(&server.verifying_key(), &text, &signature, MACHINE, NOW),
            Err(TicketError::BadSignature)
        );
    }

    #[test]
    fn a_changed_ticket_fails_its_signature() {
        let key = SigningKey::from_bytes(&[9; 32]);
        let (_, signature) = signed(&key, &ticket_json(json!({})));
        let (forged, _) = signed(
            &key,
            &ticket_json(json!({ "permissions": ["view", "terminal", "files"] })),
        );
        assert_eq!(
            open_ticket(&key.verifying_key(), &forged, &signature, MACHINE, NOW),
            Err(TicketError::BadSignature)
        );
        assert_eq!(
            open_ticket(
                &key.verifying_key(),
                "not base64!",
                &signature,
                MACHINE,
                NOW
            ),
            Err(TicketError::NotBase64)
        );
    }

    #[test]
    fn time_machine_and_permission_are_checked() {
        let key = SigningKey::from_bytes(&[9; 32]);
        let good = ticket_json(json!({}));
        assert_eq!(
            open(&key, &good, NOW + 60_000 + TICKET_CLOCK_GRACE_MS + 1),
            Err(TicketError::Expired)
        );
        assert_eq!(
            open(&key, &good, NOW - TICKET_CLOCK_GRACE_MS - 1),
            Err(TicketError::NotYetValid)
        );
        assert_eq!(
            open(
                &key,
                &ticket_json(json!({ "expiresAtMs": NOW + 600_000 })),
                NOW
            ),
            Err(TicketError::TooLong)
        );
        assert_eq!(
            open(
                &key,
                &ticket_json(json!({ "machineId": "someone-else" })),
                NOW
            ),
            Err(TicketError::WrongMachine)
        );
        assert_eq!(
            open(&key, &ticket_json(json!({ "permissions": ["view"] })), NOW),
            Err(TicketError::MissingPermission("terminal"))
        );
        let exec = ticket_json(json!({
            "purpose": {
                "kind": "exec", "shell": "sh", "command": "uptime",
                "timeoutMs": 60_000, "maxOutputBytes": 1_048_576
            }
        }));
        assert_eq!(
            open(&key, &exec, NOW),
            Err(TicketError::MissingPermission("ai-commands"))
        );
        let files = ticket_json(json!({ "purpose": { "kind": "files" } }));
        assert_eq!(
            open(&key, &files, NOW),
            Err(TicketError::MissingPermission("files"))
        );
        let allowed = ticket_json(json!({
            "permissions": ["view", "files"],
            "purpose": { "kind": "files" }
        }));
        assert_eq!(
            open(&key, &allowed, NOW).unwrap().purpose,
            SessionPurpose::Files {}
        );
        assert!(matches!(
            open(
                &key,
                &ticket_json(json!({
                    "permissions": ["view", "files"],
                    "purpose": { "kind": "files", "readOnly": false }
                })),
                NOW
            ),
            Err(TicketError::NotATicket(_))
        ));
    }

    #[test]
    fn unknown_ticket_fields_are_refused() {
        let key = SigningKey::from_bytes(&[9; 32]);
        assert!(matches!(
            open(&key, &ticket_json(json!({ "readOnly": true })), NOW),
            Err(TicketError::NotATicket(_))
        ));
        assert!(matches!(
            open(
                &key,
                &ticket_json(json!({ "runAs": { "kind": "user", "name": "kim" } })),
                NOW
            ),
            Err(TicketError::NotATicket(_))
        ));
    }

    #[test]
    fn session_messages_match_the_server_shapes() {
        assert_eq!(
            serde_json::from_value::<SessionControl>(
                json!({ "type": "resize", "cols": 120, "rows": 40 })
            )
            .unwrap(),
            SessionControl::Resize {
                cols: 120,
                rows: 40
            }
        );
        assert_eq!(
            serde_json::to_value(SessionEvent::Exited { code: 130 }).unwrap(),
            json!({ "type": "exited", "code": 130 })
        );
        assert_eq!(
            serde_json::to_value(SessionEvent::Failed {
                message: "no".into()
            })
            .unwrap(),
            json!({ "type": "failed", "message": "no" })
        );
        assert_eq!(
            serde_json::to_value(SessionEvent::ExecDone {
                exit_code: 0,
                duration_ms: 12,
                truncated: false,
                timed_out: false
            })
            .unwrap(),
            json!({ "type": "exec-done", "exitCode": 0, "durationMs": 12, "truncated": false, "timedOut": false })
        );
        assert_eq!(session_socket_path("abc"), "/agent/v1/sessions/abc");
    }
}
