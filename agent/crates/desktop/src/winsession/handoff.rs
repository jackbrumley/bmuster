//! The messages between the Windows service and its desktop helper
//! (SPEC-DESKTOP 6.2), and how they are framed on the named pipe.
//!
//! Each message is four bytes of little-endian length, then that many bytes
//! of JSON. The pipe carries only start, stop and status: the ticket goes to
//! the helper here and never on its command line, and video never crosses
//! the pipe (the helper opens its own session socket).

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};

/// The largest message either side accepts. A start message (a ticket and
/// its signature) is about 1 KB.
pub const MAX_MESSAGE: usize = 64 * 1024;

/// Service to helper.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ToHelper {
    /// Run this desktop session. The helper checks the ticket again.
    Start {
        session_id: String,
        /// The ticket and the server's signature, base64, exactly as
        /// `session-open` carried them.
        ticket: String,
        signature: String,
        /// When the service admitted the ticket, on the server's clock. The
        /// helper checks the ticket's time window against this, so a session
        /// handed to a new helper ten minutes later still checks out; the
        /// server only accepts a session socket for a live session anyway.
        admitted_at_ms: i64,
        /// The service's correction from this machine's clock to the
        /// server's, so the helper's signed requests use the same clock.
        clock_offset_ms: i64,
        /// True when the session moves from another helper (the console
        /// session changed): the browser keeps its session.
        resume: bool,
    },
    /// End this session (the agent is stopping).
    Stop { session_id: String },
    /// End every session and exit.
    Quit,
}

/// Helper to service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FromHelper {
    /// The helper is up, in this console session.
    Hello {
        process_id: u32,
        console_session: u32,
    },
    /// The session's socket is open.
    Attached { session_id: String },
    /// The session ended; `reason` is for the log.
    Ended { session_id: String, reason: String },
    /// The session could not start; the message is for the console.
    Failed { session_id: String, message: String },
    /// Ctrl+Alt+Del from a control session: only a service may call
    /// `SendSAS`.
    SecureAttention,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

/// Writes one framed message.
pub fn write_message<T: Serialize>(writer: &mut impl Write, message: &T) -> io::Result<()> {
    let json = serde_json::to_vec(message).map_err(|e| invalid(e.to_string()))?;
    if json.len() > MAX_MESSAGE {
        return Err(invalid(format!(
            "a {} byte message is over the {MAX_MESSAGE} byte limit",
            json.len()
        )));
    }
    let mut frame = Vec::with_capacity(4 + json.len());
    frame.extend_from_slice(&(json.len() as u32).to_le_bytes());
    frame.extend_from_slice(&json);
    // One write per message: a message pipe keeps it whole.
    writer.write_all(&frame)?;
    writer.flush()
}

/// Reads one framed message. `Ok(None)` when the other side closed the pipe
/// between messages; a pipe that closes inside a message is an error.
pub fn read_message<T: DeserializeOwned>(reader: &mut impl Read) -> io::Result<Option<T>> {
    let mut length = [0u8; 4];
    let mut got = 0;
    while got < length.len() {
        match reader.read(&mut length[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) if e.kind() == io::ErrorKind::BrokenPipe && got == 0 => return Ok(None),
            Err(e) => return Err(e),
        }
    }
    let length = u32::from_le_bytes(length) as usize;
    if length > MAX_MESSAGE {
        return Err(invalid(format!(
            "a {length} byte message is over the {MAX_MESSAGE} byte limit"
        )));
    }
    let mut json = vec![0u8; length];
    reader.read_exact(&mut json)?;
    serde_json::from_slice(&json)
        .map(Some)
        .map_err(|e| invalid(format!("unreadable message: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn start() -> ToHelper {
        ToHelper::Start {
            session_id: "s-1".into(),
            ticket: "eyJ0aWNrZXQiOjF9".into(),
            signature: "c2lnbmF0dXJl".into(),
            admitted_at_ms: 1_700_000_000_000,
            clock_offset_ms: -250,
            resume: false,
        }
    }

    #[test]
    fn handoff_messages_round_trip_through_frames() {
        let mut pipe = Vec::new();
        write_message(&mut pipe, &start()).unwrap();
        write_message(&mut pipe, &ToHelper::Quit).unwrap();
        let mut reader = Cursor::new(pipe);
        assert_eq!(
            read_message::<ToHelper>(&mut reader).unwrap(),
            Some(start())
        );
        assert_eq!(
            read_message::<ToHelper>(&mut reader).unwrap(),
            Some(ToHelper::Quit)
        );
        assert_eq!(read_message::<ToHelper>(&mut reader).unwrap(), None);
    }

    #[test]
    fn handoff_frames_are_length_then_camel_case_json() {
        let mut pipe = Vec::new();
        write_message(
            &mut pipe,
            &FromHelper::Attached {
                session_id: "s-2".into(),
            },
        )
        .unwrap();
        let json = br#"{"type":"attached","sessionId":"s-2"}"#;
        assert_eq!(&pipe[..4], &(json.len() as u32).to_le_bytes());
        assert_eq!(&pipe[4..], json);
        let mut reader = Cursor::new(pipe);
        assert_eq!(
            read_message::<FromHelper>(&mut reader).unwrap(),
            Some(FromHelper::Attached {
                session_id: "s-2".into()
            })
        );
    }

    #[test]
    fn handoff_refuses_oversized_truncated_and_unknown_messages() {
        let mut huge = Vec::new();
        huge.extend_from_slice(&((MAX_MESSAGE + 1) as u32).to_le_bytes());
        let error = read_message::<ToHelper>(&mut Cursor::new(huge)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);

        let mut pipe = Vec::new();
        write_message(&mut pipe, &start()).unwrap();
        pipe.truncate(pipe.len() - 3);
        let error = read_message::<ToHelper>(&mut Cursor::new(pipe)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);

        // Half a length prefix is a broken pipe, not a clean close.
        let error = read_message::<ToHelper>(&mut Cursor::new(vec![9, 0])).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);

        let json = br#"{"type":"stop","sessionId":"s","extra":true}"#;
        let mut pipe = (json.len() as u32).to_le_bytes().to_vec();
        pipe.extend_from_slice(json);
        let error = read_message::<ToHelper>(&mut Cursor::new(pipe)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidData);

        let too_big = ToHelper::Stop {
            session_id: "x".repeat(MAX_MESSAGE),
        };
        assert!(write_message(&mut Vec::new(), &too_big).is_err());
    }
}
