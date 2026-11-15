//! The tray notice for a finished drop (SPEC-SESSION-FILES 4.3, 4.7).
//!
//! The helper writes `<batch>.json` into the person's own private folder
//! (`$XDG_RUNTIME_DIR/bmuster/notices`, `%LOCALAPPDATA%\BMuster\notices`);
//! the tray, running as the same person, takes each file once and deletes
//! it. Same person both ends, so no privilege boundary is crossed, and the
//! tray still treats the file as untrusted text: names are cleaned, at most
//! five are listed, files over 16 KB, malformed or older than ten minutes
//! are deleted unread, and nothing in the file is ever used as a path (the
//! tray works out the folder itself and selects only names that exist
//! directly inside it).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// A notice file larger than this is deleted unread.
pub const MAX_BYTES: u64 = 16 * 1024;
/// A notice older than this is deleted unshown.
pub const MAX_AGE_MS: u64 = 10 * 60_000;
/// Names listed in the notice; the rest are "and N more".
const LISTED: usize = 5;
/// Names written to the file at most.
const WRITTEN: usize = 100;

/// The notice file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NoticeFile {
    pub sender: String,
    pub names: Vec<String>,
    pub count: usize,
    pub created_ms: u64,
}

/// The person's notices folder, for the helper and the tray alike.
pub fn folder() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        std::env::var_os("XDG_RUNTIME_DIR")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join("bmuster").join("notices"))
    }
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .map(|dir| dir.join("BMuster").join("notices"))
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

/// Writes the notice for one batch (`batch_id` is the server's id).
pub fn write(dir: &Path, batch_id: &str, sender: &str, names: &[String]) -> std::io::Result<()> {
    if batch_id.is_empty() || !batch_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let file = NoticeFile {
        sender: sender.chars().take(200).collect(),
        names: names.iter().take(WRITTEN).cloned().collect(),
        count: names.len(),
        created_ms: now_ms(),
    };
    let staged = dir.join(format!(".{batch_id}.tmp"));
    std::fs::write(&staged, serde_json::to_vec(&file)?)?;
    std::fs::rename(staged, dir.join(format!("{batch_id}.json")))
}

/// What the tray shows for one notice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Shown {
    /// "Jack sent you report.pdf (Downloads/BMuster)".
    pub summary: String,
    /// The cleaned names, to select only those that exist in the folder.
    pub names: Vec<String>,
}

/// A name for the notice: no control characters, at most 64 characters.
fn clean(name: &str) -> String {
    crate::tray::viewers::clean_name(name)
}

/// The notice's words, or `None` for a file to ignore.
pub fn shown(bytes: &[u8], now: u64, folder_label: &str) -> Option<Shown> {
    if bytes.len() as u64 > MAX_BYTES {
        return None;
    }
    let file: NoticeFile = serde_json::from_slice(bytes).ok()?;
    if file.created_ms > now + 60_000 || now.saturating_sub(file.created_ms) > MAX_AGE_MS {
        return None;
    }
    if file.names.is_empty() || file.count < file.names.len() {
        return None;
    }
    let sender = clean(&file.sender);
    let names: Vec<String> = file.names.iter().map(|name| clean(name)).collect();
    let what = if file.count == 1 {
        names[0].clone()
    } else if file.count <= LISTED {
        format!("{} files: {}", file.count, names.join(", "))
    } else {
        format!(
            "{} files: {} and {} more",
            file.count,
            names[..LISTED].join(", "),
            file.count - LISTED
        )
    };
    Some(Shown {
        summary: format!("{sender} sent you {what} ({folder_label})"),
        names,
    })
}

/// Takes every notice in `dir` once: each file is deleted whatever it held,
/// and the ones worth showing are returned.
pub fn take(dir: &Path, now: u64, folder_label: &str) -> Vec<Shown> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let is_notice = path.extension().is_some_and(|ext| ext == "json")
            && entry.file_type().is_ok_and(|kind| kind.is_file());
        if !is_notice {
            continue;
        }
        let small = entry.metadata().is_ok_and(|m| m.len() <= MAX_BYTES);
        let bytes = if small {
            std::fs::read(&path).ok()
        } else {
            None
        };
        let _ = std::fs::remove_file(&path);
        if let Some(shown) = bytes.and_then(|bytes| shown(&bytes, now, folder_label)) {
            found.push(shown);
        }
    }
    found
}

/// The files of a notice that exist directly inside `folder`: the only
/// ones the tray ever selects.
pub fn existing_in(folder: &Path, names: &[String]) -> Vec<PathBuf> {
    names
        .iter()
        .filter(|name| super::names::check(name).is_ok())
        .map(|name| folder.join(name))
        .filter(|path| {
            std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
                && path.parent() == Some(folder)
        })
        .collect()
}
