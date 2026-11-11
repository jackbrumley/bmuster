//! File sessions (`docs/specs/SPEC-FILES.md`): the messages on a `files`
//! session's socket. The server is the other end (not a browser): it sends
//! numbered requests and the agent answers each one, in any order.
//!
//! - Server to agent, text: [`FilesRequest`], e.g.
//!   `{"id":7,"op":"list","path":"/srv"}`. A `write-chunk` is followed by one
//!   binary frame with the chunk's data.
//! - Agent to server, text: [`FilesReply`], `done` with a result or `error`.
//! - Binary frames, both ways: [`frame`], a 4-byte big-endian request id and
//!   then the bytes (a read's data, a chunk's data).
//!
//! Reads are flow-controlled per request: the agent sends at most
//! [`READ_WINDOW`] bytes ahead of the server's `ack`s, so a slow download
//! never holds up the socket for the other requests.

use serde::{Deserialize, Serialize};

/// The most entries one listing returns; `more` says there were others.
pub const MAX_LIST_ENTRIES: usize = 5_000;

/// Bytes a read may run ahead of the server's acknowledgements.
pub const READ_WINDOW: u64 = 4 * 1024 * 1024;

/// The largest upload chunk (adapter-node's body limit is 16 MB).
pub const MAX_CHUNK_BYTES: usize = 8 * 1024 * 1024;

/// The bytes of one read frame at most.
pub const READ_FRAME_BYTES: usize = 64 * 1024;

/// Suffix of an upload's partial file, beside where it will end up.
pub const PART_SUFFIX: &str = ".bmuster-part";

/// One request from the server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilesRequest {
    pub id: u32,
    #[serde(flatten)]
    pub op: FilesOp,
}

/// What the server asks. Paths are absolute; `name`s are one part.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum FilesOp {
    /// Drives (Windows) or `/` and mount points.
    Roots,
    List {
        path: String,
    },
    /// Follows links: what a download would read.
    Stat {
        path: String,
    },
    Mkdir {
        dir: String,
        name: String,
    },
    Rename {
        dir: String,
        from: String,
        to: String,
    },
    Delete {
        dir: String,
        names: Vec<String>,
        recursive: bool,
    },
    /// `length` bytes from `offset` (fewer at the end of the file).
    Read {
        path: String,
        offset: u64,
        length: u64,
    },
    WriteBegin {
        dir: String,
        name: String,
        size: u64,
        replace: bool,
    },
    WriteChunk {
        dir: String,
        name: String,
        offset: u64,
    },
    WriteEnd {
        dir: String,
        name: String,
        size: u64,
        sha256: String,
    },
    WriteCancel {
        dir: String,
        name: String,
    },
    /// The server has passed on this many more bytes of read `id`.
    Ack {
        bytes: u64,
    },
    /// Stop read `id` (the download was abandoned).
    Cancel,
    /// Each scanned drive and its scan state (SPEC-STORAGE 5).
    StorageSummary,
    /// One scanned folder of the drive at `mount`, sub-folders from `offset`.
    StorageFolder {
        mount: String,
        path: String,
        offset: u64,
    },
    /// The largest files under `path` from the drive's last scan.
    StorageLargest {
        mount: String,
        path: String,
    },
    /// Start a scan pass now.
    StorageRescan,
}

/// The agent's answer to one request.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum FilesReply {
    Done {
        id: u32,
        result: FilesResult,
    },
    Error {
        id: u32,
        code: ErrorCode,
        message: String,
    },
}

/// Why a request failed, for the server to pick a status.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    /// A path or name that is not allowed.
    Invalid,
    NotFound,
    Exists,
    NotEmpty,
    Denied,
    NoSpace,
    /// An upload chunk did not start where the part file ends.
    Offset,
    /// The finished upload's size or SHA-256 is not what the browser sent.
    Mismatch,
    /// Too much at once, or another chunk for the same file is being written.
    Busy,
    Io,
}

/// The result of a request, by op.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum FilesResult {
    Roots {
        roots: Vec<Root>,
    },
    Listing {
        path: String,
        entries: Vec<Entry>,
        more: bool,
    },
    Stat(Stat),
    Path {
        path: String,
    },
    Deleted {
        removed: Vec<String>,
        /// Files, folders and links removed, counting what was inside folders.
        items: u64,
        failed: Vec<Failure>,
    },
    Read {
        bytes: u64,
    },
    #[serde(rename_all = "camelCase")]
    Part {
        part_size: u64,
    },
    Written {
        path: String,
        size: u64,
        sha256: String,
    },
    StorageSummary {
        drives: Vec<crate::storage::DriveSummary>,
        problem: crate::storage::StorageProblem,
    },
    StorageFolder(crate::storage::FolderView),
    StorageLargest {
        files: Vec<crate::storage::LargeFile>,
    },
    Nothing {},
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RootKind {
    Drive,
    Mount,
}

/// A drive or a mounted file system.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Root {
    pub path: String,
    /// "Local disk", "Network drive", the file system type…
    pub label: String,
    pub kind: RootKind,
    pub total_bytes: Option<u64>,
    pub free_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EntryKind {
    File,
    Folder,
    Link,
    Other,
}

/// One entry of a folder. Links are described, never followed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    pub modified_ms: Option<i64>,
    pub hidden: bool,
    pub link_target: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub kind: EntryKind,
    pub size: u64,
    pub modified_ms: Option<i64>,
}

/// One name a delete could not remove.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Failure {
    pub name: String,
    pub message: String,
}

/// A binary frame: the request id, then the bytes.
pub fn frame(id: u32, bytes: &[u8]) -> Vec<u8> {
    let mut framed = Vec::with_capacity(4 + bytes.len());
    framed.extend_from_slice(&id.to_be_bytes());
    framed.extend_from_slice(bytes);
    framed
}

/// The request id and the bytes of a binary frame, or None if it is too short.
pub fn split_frame(framed: &[u8]) -> Option<(u32, &[u8])> {
    let (head, rest) = framed.split_first_chunk::<4>()?;
    Some((u32::from_be_bytes(*head), rest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn requests_read_as_the_server_writes_them() {
        let request: FilesRequest =
            serde_json::from_value(json!({ "id": 7, "op": "list", "path": "/srv" })).unwrap();
        assert_eq!(
            request,
            FilesRequest {
                id: 7,
                op: FilesOp::List {
                    path: "/srv".into()
                }
            }
        );
        let roots: FilesRequest =
            serde_json::from_value(json!({ "id": 1, "op": "roots" })).unwrap();
        assert_eq!(roots.op, FilesOp::Roots);
        let begin: FilesRequest = serde_json::from_value(json!({
            "id": 2, "op": "write-begin", "dir": "/tmp", "name": "a.bin", "size": 10, "replace": false
        }))
        .unwrap();
        assert_eq!(
            begin.op,
            FilesOp::WriteBegin {
                dir: "/tmp".into(),
                name: "a.bin".into(),
                size: 10,
                replace: false
            }
        );
        let folder: FilesRequest = serde_json::from_value(json!({
            "id": 5, "op": "storage-folder", "mount": "/", "path": "/var", "offset": 200
        }))
        .unwrap();
        assert_eq!(
            folder.op,
            FilesOp::StorageFolder {
                mount: "/".into(),
                path: "/var".into(),
                offset: 200
            }
        );
        let summary: FilesRequest =
            serde_json::from_value(json!({ "id": 6, "op": "storage-summary" })).unwrap();
        assert_eq!(summary.op, FilesOp::StorageSummary);
        let cancel: FilesRequest =
            serde_json::from_value(json!({ "id": 3, "op": "cancel" })).unwrap();
        assert_eq!(cancel.op, FilesOp::Cancel);
        assert!(
            serde_json::from_value::<FilesRequest>(json!({ "id": 4, "op": "format-disk" }))
                .is_err()
        );
    }

    #[test]
    fn replies_match_the_server_shapes() {
        assert_eq!(
            serde_json::to_value(FilesReply::Done {
                id: 2,
                result: FilesResult::Part { part_size: 8 }
            })
            .unwrap(),
            json!({ "type": "done", "id": 2, "result": { "partSize": 8 } })
        );
        assert_eq!(
            serde_json::to_value(FilesReply::Error {
                id: 3,
                code: ErrorCode::NotFound,
                message: "gone".into()
            })
            .unwrap(),
            json!({ "type": "error", "id": 3, "code": "not-found", "message": "gone" })
        );
        assert_eq!(
            serde_json::to_value(FilesResult::Nothing {}).unwrap(),
            json!({})
        );
        assert_eq!(
            serde_json::to_value(Entry {
                name: "a".into(),
                kind: EntryKind::Link,
                size: 0,
                modified_ms: None,
                hidden: false,
                link_target: Some("/etc".into())
            })
            .unwrap(),
            json!({ "name": "a", "kind": "link", "size": 0, "modifiedMs": null, "hidden": false, "linkTarget": "/etc" })
        );
    }

    #[test]
    fn frames_carry_their_request_id() {
        let framed = frame(0x0102_0304, b"data");
        assert_eq!(&framed[..4], &[1, 2, 3, 4]);
        assert_eq!(split_frame(&framed), Some((0x0102_0304, &b"data"[..])));
        assert_eq!(split_frame(&[1, 2]), None);
    }
}
