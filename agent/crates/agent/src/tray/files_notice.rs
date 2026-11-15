//! The tray's side of files sent through a desktop session
//! (SPEC-SESSION-FILES 4.7): each poll takes the notices the person's own
//! user files helper left, once, and says what to show. The folder is
//! worked out here, by the same lookup the helper uses, and only names
//! that exist directly inside it are selected.

use crate::user_files::{folder, notice};
use bmuster_protocol::user_files::FOLDER_NAME;
use std::path::PathBuf;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

/// The notices that arrived since the last call: the words, the folder and
/// the files in it to select.
pub fn arrived() -> Vec<(String, PathBuf, Vec<PathBuf>)> {
    let Some(dir) = notice::folder() else {
        return Vec::new();
    };
    if !dir.is_dir() {
        return Vec::new();
    }
    let Ok((downloads, label, _)) = folder::this_person() else {
        // Notices still expire: take them so they do not pile up.
        let _ = notice::take(&dir, now_ms(), "");
        return Vec::new();
    };
    let target = downloads.join(FOLDER_NAME);
    notice::take(&dir, now_ms(), &label)
        .into_iter()
        .map(|shown| {
            let files = notice::existing_in(&target, &shown.names);
            (shown.summary, target.clone(), files)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SF12: one notice per batch, shown once, deleted, never trusted as a path.
    #[test]
    fn sf12_notices_are_shown_once_and_never_trusted_as_paths() {
        let dir = tempfile::tempdir().unwrap();
        let notices = dir.path().join("notices");
        let batch = "4f1e2d3c-0000-4000-8000-000000000001";
        notice::write(
            &notices,
            batch,
            "Jack\u{1b}[31m Brumley",
            &["report.pdf".to_string()],
        )
        .unwrap();
        assert!(notice::write(&notices, "../x", "Jack", &["a".into()]).is_err());
        let now = now_ms();
        let shown = notice::take(&notices, now, "Downloads/BMuster");
        assert_eq!(shown.len(), 1);
        assert_eq!(
            shown[0].summary,
            "Jack[31m Brumley sent you report.pdf (Downloads/BMuster)"
        );
        assert!(
            notice::take(&notices, now, "Downloads/BMuster").is_empty(),
            "once"
        );
        assert_eq!(std::fs::read_dir(&notices).unwrap().count(), 0, "deleted");

        let many: Vec<String> = (1..=7).map(|n| format!("f{n}.txt")).collect();
        notice::write(&notices, batch, "Jack", &many).unwrap();
        assert_eq!(
            notice::take(&notices, now, "Downloads/BMuster")[0].summary,
            "Jack sent you 7 files: f1.txt, f2.txt, f3.txt, f4.txt, f5.txt and 2 more (Downloads/BMuster)"
        );

        // Oversized, stale and malformed files are deleted unread.
        std::fs::write(notices.join("big.json"), vec![b' '; 20_000]).unwrap();
        std::fs::write(notices.join("bad.json"), b"{\"sender\":1}").unwrap();
        let stale = notice::NoticeFile {
            sender: "Jack".into(),
            names: vec!["a".into()],
            count: 1,
            created_ms: now - notice::MAX_AGE_MS - 1,
        };
        std::fs::write(
            notices.join("old.json"),
            serde_json::to_vec(&stale).unwrap(),
        )
        .unwrap();
        assert!(notice::take(&notices, now, "Downloads/BMuster").is_empty());
        assert_eq!(std::fs::read_dir(&notices).unwrap().count(), 0);

        // Only plain names that exist directly in the folder are selected.
        let target = dir.path().join("BMuster");
        std::fs::create_dir(&target).unwrap();
        std::fs::write(target.join("report.pdf"), b"x").unwrap();
        std::fs::write(dir.path().join("secret"), b"x").unwrap();
        let picked = notice::existing_in(
            &target,
            &[
                "report.pdf".into(),
                "../secret".into(),
                "/etc/passwd".into(),
                "missing.txt".into(),
            ],
        );
        assert_eq!(picked, [target.join("report.pdf")]);
    }
}
