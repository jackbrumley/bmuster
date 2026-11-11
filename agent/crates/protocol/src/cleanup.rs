//! Storage clean-up (`docs/specs/SPEC-STORAGE.md` section 11): a fixed,
//! per-system list of known-safe items. Requests name items by
//! [`CleanupItem`] only, a closed list: no path, pattern or command ever
//! crosses the wire. The agent decides everything an item touches from its
//! id and the machine's own folders.

use serde::{Deserialize, Serialize};

/// One item of the clean-up list. Windows items first, then Linux; an item
/// of the other system is never offered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CleanupItem {
    WindowsUserTemp,
    WindowsTemp,
    WindowsUpdateCache,
    DeliveryOptimisationCache,
    WindowsCrashDumps,
    RecycleBins,
    ComponentStore,
    PackageCache,
    Journal,
    LinuxCrashDumps,
    OldVarTmp,
    UnusedFlatpaks,
    ThumbnailCaches,
}

/// Every item, in the order the console lists them.
pub const CLEANUP_ITEMS: [CleanupItem; 13] = [
    CleanupItem::WindowsUserTemp,
    CleanupItem::WindowsTemp,
    CleanupItem::WindowsUpdateCache,
    CleanupItem::DeliveryOptimisationCache,
    CleanupItem::WindowsCrashDumps,
    CleanupItem::RecycleBins,
    CleanupItem::ComponentStore,
    CleanupItem::PackageCache,
    CleanupItem::Journal,
    CleanupItem::LinuxCrashDumps,
    CleanupItem::OldVarTmp,
    CleanupItem::UnusedFlatpaks,
    CleanupItem::ThumbnailCaches,
];

/// What an item would free, measured before anything is ticked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum CleanupSize {
    Bytes {
        bytes: u64,
        files: u64,
    },
    /// Only known afterwards (a system tool that reports no size).
    Unknown,
}

/// One offered item and its size.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemSize {
    pub id: CleanupItem,
    pub size: CleanupSize,
}

/// How an item's freed bytes were found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Measured {
    /// The sizes of what was deleted (or of the folders before and after).
    Counted,
    /// The drive's free space after minus before: other activity can move it.
    FreeSpace,
}

/// The most error messages one item keeps; `errors` counts them all.
pub const MAX_MESSAGES: usize = 5;

/// What one item did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemResult {
    pub freed_bytes: u64,
    pub measured: Measured,
    pub files_removed: u64,
    /// In use, denied, or changed since it was listed.
    pub files_skipped: u64,
    pub errors: u64,
    /// The first few errors, in plain words.
    pub messages: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ItemState {
    Waiting,
    Running {
        freed_bytes: u64,
        files_removed: u64,
    },
    Done {
        result: ItemResult,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemProgress {
    pub id: CleanupItem,
    pub state: ItemState,
}

/// The machine's last clean-up, if any. `Interrupted` is a run whose
/// cleaner stopped before the end (killed, or the agent stopped).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum CleanupRun {
    #[default]
    None,
    Running {
        run_id: String,
        started_at_ms: i64,
        items: Vec<ItemProgress>,
    },
    Finished {
        run_id: String,
        started_at_ms: i64,
        finished_at_ms: i64,
        items: Vec<ItemProgress>,
    },
    Interrupted {
        run_id: String,
        started_at_ms: i64,
        items: Vec<ItemProgress>,
    },
}

/// Whether `run_id` is one the server makes (a UUID): it names a file's
/// content and is echoed back, so anything else is refused.
pub fn valid_run_id(run_id: &str) -> bool {
    run_id.len() == 36
        && run_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn s17_items_are_a_closed_list_of_ids() {
        let item: CleanupItem = serde_json::from_value(json!("old-var-tmp")).unwrap();
        assert_eq!(item, CleanupItem::OldVarTmp);
        assert_eq!(
            serde_json::to_value(CleanupItem::DeliveryOptimisationCache).unwrap(),
            json!("delivery-optimisation-cache")
        );
        for refused in [
            json!("/etc"),
            json!("C:\\Windows"),
            json!("rm -rf /"),
            json!(3),
        ] {
            assert!(serde_json::from_value::<CleanupItem>(refused).is_err());
        }
        let mut sorted = CLEANUP_ITEMS;
        sorted.sort();
        sorted
            .windows(2)
            .for_each(|pair| assert_ne!(pair[0], pair[1]));
    }

    #[test]
    fn s17_run_ids_are_uuids() {
        assert!(valid_run_id("0f8fad5b-d9cb-469f-a165-70867728950e"));
        assert!(!valid_run_id(""));
        assert!(!valid_run_id("../../etc/passwd-aaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(!valid_run_id("0f8fad5b-d9cb-469f-a165-70867728950e0"));
    }

    #[test]
    fn runs_match_the_server_shapes() {
        let run = CleanupRun::Finished {
            run_id: "r".into(),
            started_at_ms: 1,
            finished_at_ms: 2,
            items: vec![
                ItemProgress {
                    id: CleanupItem::Journal,
                    state: ItemState::Done {
                        result: ItemResult {
                            freed_bytes: 10,
                            measured: Measured::Counted,
                            files_removed: 2,
                            files_skipped: 1,
                            errors: 0,
                            messages: vec![],
                        },
                    },
                },
                ItemProgress {
                    id: CleanupItem::UnusedFlatpaks,
                    state: ItemState::Running {
                        freed_bytes: 3,
                        files_removed: 4,
                    },
                },
            ],
        };
        assert_eq!(
            serde_json::to_value(&run).unwrap(),
            json!({
                "kind": "finished", "runId": "r", "startedAtMs": 1, "finishedAtMs": 2,
                "items": [
                    { "id": "journal", "state": { "kind": "done", "result": {
                        "freedBytes": 10, "measured": "counted", "filesRemoved": 2,
                        "filesSkipped": 1, "errors": 0, "messages": []
                    } } },
                    { "id": "unused-flatpaks", "state": { "kind": "running", "freedBytes": 3, "filesRemoved": 4 } }
                ]
            })
        );
        assert_eq!(
            serde_json::to_value(CleanupRun::None).unwrap(),
            json!({ "kind": "none" })
        );
        assert_eq!(
            serde_json::to_value(ItemSize {
                id: CleanupItem::ComponentStore,
                size: CleanupSize::Unknown
            })
            .unwrap(),
            json!({ "id": "component-store", "size": { "kind": "unknown" } })
        );
    }
}
