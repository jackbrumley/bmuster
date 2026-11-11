//! Storage (`docs/specs/SPEC-STORAGE.md`): what the background scan found,
//! as the agent reports it. Folder names and file paths travel only in
//! answers to `storage-*` requests on a files session ([`crate::files`]);
//! the check-in's [`StorageReport`] has mount paths and byte counts only.

use serde::{Deserialize, Serialize};

/// Sub-folders in one `storage-folder` answer at most.
pub const FOLDER_PAGE: usize = 200;

/// Files in one `storage-largest` answer at most.
pub const LARGEST_PAGE: usize = 100;

/// One scanned drive: its live size and free space, its last complete scan
/// and whether a pass is scanning it now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveSummary {
    pub mount: String,
    pub size_bytes: u64,
    pub free_bytes: u64,
    pub last_scan: LastScan,
    pub scanning: Scanning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LastScan {
    None,
    #[serde(rename_all = "camelCase")]
    Complete {
        started_at_ms: i64,
        finished_at_ms: i64,
        /// What the scan counted (used space minus this was not seen).
        scanned_bytes: u64,
        /// The drive's used bytes when the scan finished.
        used_bytes: u64,
        files: u64,
        folders: u64,
        /// Folders the scanner could not read.
        denied: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Scanning {
    Idle,
    #[serde(rename_all = "camelCase")]
    Running {
        started_at_ms: i64,
        /// Counted bytes against the drive's used bytes, 0 to 99.
        percent: u8,
    },
}

/// The last pass's trouble, if any (a scan that could not be saved).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum StorageProblem {
    #[default]
    None,
    #[serde(rename_all = "camelCase")]
    Failed { message: String, at_ms: i64 },
}

/// The check-in's `storage`; older agents send none.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum StorageReport {
    #[default]
    Unreported,
    Reported {
        drives: Vec<DriveSummary>,
    },
}

/// One kept sub-folder of a scanned folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderChild {
    pub name: String,
    /// The full path, for the next `storage-folder`.
    pub path: String,
    pub bytes: u64,
    pub files: u64,
    /// Whether it has kept sub-folders of its own (worth drilling into).
    pub has_children: bool,
}

/// One scanned folder, its sub-folders biggest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderView {
    pub mount: String,
    pub path: String,
    pub finished_at_ms: i64,
    pub bytes: u64,
    pub files: u64,
    /// Files directly in this folder.
    pub own_bytes: u64,
    pub own_files: u64,
    /// Sub-folders too small to keep, folded into this one.
    pub folded_folders: u64,
    pub folded_bytes: u64,
    /// At the drive's root: used space the scan did not see; 0 below it.
    pub not_scanned_bytes: u64,
    pub children: Vec<FolderChild>,
    pub offset: u64,
    pub more: bool,
}

/// One of the largest files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFile {
    pub path: String,
    pub bytes: u64,
    pub modified_ms: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_check_in_without_storage_reads_as_unreported() {
        let report: StorageReport =
            serde_json::from_value(json!({ "kind": "unreported" })).unwrap();
        assert_eq!(report, StorageReport::Unreported);
        assert_eq!(StorageReport::default(), StorageReport::Unreported);
    }

    #[test]
    fn drive_summaries_match_the_server_shapes() {
        let drive = DriveSummary {
            mount: "/".into(),
            size_bytes: 100,
            free_bytes: 40,
            last_scan: LastScan::Complete {
                started_at_ms: 1,
                finished_at_ms: 2,
                scanned_bytes: 50,
                used_bytes: 60,
                files: 3,
                folders: 4,
                denied: 0,
            },
            scanning: Scanning::Running {
                started_at_ms: 5,
                percent: 42,
            },
        };
        assert_eq!(
            serde_json::to_value(StorageReport::Reported {
                drives: vec![drive]
            })
            .unwrap(),
            json!({
                "kind": "reported",
                "drives": [{
                    "mount": "/",
                    "sizeBytes": 100,
                    "freeBytes": 40,
                    "lastScan": {
                        "kind": "complete", "startedAtMs": 1, "finishedAtMs": 2, "scannedBytes": 50,
                        "usedBytes": 60, "files": 3, "folders": 4, "denied": 0
                    },
                    "scanning": { "kind": "running", "startedAtMs": 5, "percent": 42 }
                }]
            })
        );
        assert_eq!(
            serde_json::to_value(StorageProblem::Failed {
                message: "disk full".into(),
                at_ms: 9
            })
            .unwrap(),
            json!({ "kind": "failed", "message": "disk full", "atMs": 9 })
        );
    }
}
