//! Files through a desktop session (`docs/specs/SPEC-SESSION-FILES.md`):
//! the messages on a `session-files` session's socket, which the agent
//! passes unchanged to the user files helper running as the person on the
//! screen. Framed like a files session ([`crate::files`]): numbered text
//! requests, `done` or `error` replies, and binary frames with a 4-byte
//! request id.
//!
//! Nothing here carries a path from the server: a sent file has a name
//! (one strict path part, checked by the helper) and the helper picks the
//! folder; the finished batch names transfer ids, which the helper
//! resolves to the files it saved itself.

use serde::{Deserialize, Serialize};

/// The most files in one drop.
pub const MAX_FILES_PER_BATCH: usize = 100;

/// Bytes that must stay free on the Downloads disk after a send.
pub const KEEP_FREE_BYTES: u64 = 1024 * 1024 * 1024;

/// The folder made inside the person's Downloads.
pub const FOLDER_NAME: &str = "BMuster";

/// One request from the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserFilesRequest {
    pub id: u32,
    #[serde(flatten)]
    pub op: UserFilesOp,
}

/// What the server asks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum UserFilesOp {
    /// Who is signed in on the screen and where files go.
    Target,
    /// Starts or resumes one file: checks the name, the size and free room.
    SendBegin {
        transfer_id: String,
        name: String,
        size: u64,
    },
    /// Followed by one binary frame with the bytes, appended at `offset`.
    SendChunk { transfer_id: String, offset: u64 },
    /// All sent: checks size and SHA-256, then saves under a free name.
    SendEnd {
        transfer_id: String,
        size: u64,
        sha256: String,
    },
    /// Removes the part file.
    SendCancel { transfer_id: String },
    /// The drop is over: the tray notice for the files saved in it.
    SendFinish {
        batch_id: String,
        transfer_ids: Vec<String>,
        /// The sender's name, for the notice (cleaned by the tray).
        sender: String,
    },
}

/// Why a request failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UserFilesError {
    /// A name that is not allowed, or a request out of order.
    Invalid,
    /// Nobody is signed in on the screen.
    Nobody,
    /// The screen is locked.
    Locked,
    /// Downloads\BMuster is a link, not a folder, or someone else's.
    NotOwned,
    Denied,
    NoSpace,
    Quota,
    /// A chunk did not start where the part file ends.
    Offset,
    /// The finished file's size or SHA-256 is not what was sent.
    Mismatch,
    /// The file is over the size limit.
    TooBig,
    Busy,
    Io,
}

/// The agent's answer to one request.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum UserFilesReply {
    Done {
        id: u32,
        result: UserFilesResult,
    },
    Error {
        id: u32,
        code: UserFilesError,
        message: String,
    },
}

/// The result of a request, by op.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum UserFilesResult {
    /// `target`: the person's name as the machine knows it, the folder as
    /// they would name it (`Downloads/BMuster`), and the bytes free there.
    Target {
        user: String,
        folder_label: String,
        free: u64,
    },
    /// `send-begin` and `send-chunk`: how much of the file the machine holds.
    Part { part_size: u64 },
    /// `send-end`: the name the file was saved as (never a path).
    Saved {
        saved_as: String,
        size: u64,
        sha256: String,
    },
    /// `send-finish`.
    Finished { on_clipboard: bool },
    /// `send-cancel`.
    Empty {},
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn requests_and_replies_match_the_server_shapes() {
        let request: UserFilesRequest = serde_json::from_value(json!({
            "id": 4, "op": "send-begin", "transferId": "t-1", "name": "report.pdf", "size": 12
        }))
        .unwrap();
        assert_eq!(
            request.op,
            UserFilesOp::SendBegin {
                transfer_id: "t-1".into(),
                name: "report.pdf".into(),
                size: 12
            }
        );
        assert!(serde_json::from_value::<UserFilesRequest>(
            json!({ "id": 1, "op": "send-begin", "transferId": "t", "name": "a", "size": 1, "dir": "/" })
        )
        .is_ok_and(|request| !matches!(request.op, UserFilesOp::Target)));
        assert_eq!(
            serde_json::to_value(UserFilesReply::Done {
                id: 4,
                result: UserFilesResult::Saved {
                    saved_as: "report (2).pdf".into(),
                    size: 12,
                    sha256: "ab".into()
                }
            })
            .unwrap(),
            json!({ "type": "done", "id": 4, "result": { "savedAs": "report (2).pdf", "size": 12, "sha256": "ab" } })
        );
        assert_eq!(
            serde_json::to_value(UserFilesReply::Error {
                id: 5,
                code: UserFilesError::NotOwned,
                message: "no".into()
            })
            .unwrap(),
            json!({ "type": "error", "id": 5, "code": "not-owned", "message": "no" })
        );
        assert_eq!(
            serde_json::to_value(UserFilesResult::Target {
                user: "kim".into(),
                folder_label: "Downloads/BMuster".into(),
                free: 9
            })
            .unwrap(),
            json!({ "user": "kim", "folderLabel": "Downloads/BMuster", "free": 9 })
        );
    }
}
