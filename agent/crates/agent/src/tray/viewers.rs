//! Who is connected to this machine's screen, for the tray helper
//! (SPEC-DESKTOP 8.2, notice version 2).
//!
//! Each desktop session whose ticket asks for the notice holds a
//! [`Viewer`] while it runs, on every platform (on Windows the session runs
//! in the desktop helper, but the worker's session thread waits for it, so
//! the worker still knows). The status publisher writes the names to
//! `viewers.json` beside `status.json`, with the same protections: only
//! root (SYSTEM or Administrators on Windows) can write it, and the tray
//! refuses a stale or oversized one. It is a separate file so a tray helper
//! started before this version keeps reading `status.json`.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::sync::{Mutex, MutexGuard};

/// The public file's name in the status folder.
pub const FILE: &str = "viewers.json";
/// At most this many names (the desktop allows four sessions; a refused
/// fifth may hold its place for a moment).
pub const MAX_NAMES: usize = 8;
/// A longer name is cut to this many characters.
pub const MAX_NAME_CHARS: usize = 64;

struct Registry {
    next_id: u64,
    viewers: Vec<(u64, String)>,
}

static REGISTRY: Mutex<Registry> = Mutex::new(Registry {
    next_id: 1,
    viewers: Vec::new(),
});

fn registry() -> MutexGuard<'static, Registry> {
    REGISTRY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A desktop session's place in the list; dropping it takes the name off.
#[derive(Debug)]
pub struct Viewer {
    id: u64,
}

impl Drop for Viewer {
    fn drop(&mut self) {
        registry().viewers.retain(|(id, _)| *id != self.id);
    }
}

/// Lists `name` while the returned [`Viewer`] lives.
pub fn add(name: &str) -> Viewer {
    let mut registry = registry();
    let id = registry.next_id;
    registry.next_id += 1;
    registry.viewers.push((id, clean_name(name)));
    Viewer { id }
}

/// The names of everyone connected now, in the order they joined.
pub fn names() -> Vec<String> {
    registry()
        .viewers
        .iter()
        .take(MAX_NAMES)
        .map(|(_, name)| name.clone())
        .collect()
}

/// A name the tray can show: no control characters, trimmed, at most
/// [`MAX_NAME_CHARS`] characters, never empty.
pub fn clean_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .chars()
        .take(MAX_NAME_CHARS)
        .collect();
    if cleaned.is_empty() {
        "Someone".into()
    } else {
        cleaned
    }
}

/// `viewers.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Published {
    pub schema_version: u8,
    pub published_at_ms: u64,
    pub names: Vec<String>,
}

impl Published {
    pub fn new(names: &[String], now_ms: u64) -> Self {
        Self {
            schema_version: 1,
            published_at_ms: now_ms,
            names: names.to_vec(),
        }
    }

    /// Refuses a file that is old (the agent stopped), from the future,
    /// or not one this version writes.
    pub fn validate(&self, now_ms: u64) -> Result<()> {
        if self.schema_version != 1
            || self.published_at_ms > now_ms
            || now_ms - self.published_at_ms > super::status::MAX_AGE_MS
        {
            bail!("The viewer list is missing, expired or unsupported");
        }
        // Every name is as `clean_name` leaves it (so never empty).
        if self.names.len() > MAX_NAMES || self.names.iter().any(|name| clean_name(name) != *name) {
            bail!("The viewer list is malformed");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_viewers_are_listed_while_their_session_runs() {
        let kim = add("Kim");
        let lee = add("Lee\u{7}\n");
        let listed = names();
        assert!(listed.contains(&"Kim".to_string()));
        assert!(listed.contains(&"Lee".to_string()), "control characters go");
        drop(kim);
        assert!(!names().contains(&"Kim".to_string()));
        drop(lee);
        assert!(!names().contains(&"Lee".to_string()));
    }

    #[test]
    fn tray_viewer_names_are_cleaned() {
        assert_eq!(clean_name("  Kim Lee "), "Kim Lee");
        assert_eq!(clean_name("\u{1b}[31m"), "[31m");
        assert_eq!(clean_name(""), "Someone");
        assert_eq!(clean_name(&"x".repeat(200)).chars().count(), MAX_NAME_CHARS);
    }

    #[test]
    fn tray_viewers_file_round_trips_and_refuses_stale_or_malformed_lists() {
        let at = 100_000;
        let good = Published::new(&["Kim".into(), "Lee".into()], at);
        let text = serde_json::to_string(&good).unwrap();
        assert_eq!(
            text,
            r#"{"schemaVersion":1,"publishedAtMs":100000,"names":["Kim","Lee"]}"#
        );
        let read: Published = serde_json::from_str(&text).unwrap();
        assert_eq!(read, good);
        assert!(read.validate(at + 1_000).is_ok());
        assert!(
            read.validate(at + 20_001).is_err(),
            "stale: the agent stopped"
        );
        assert!(read.validate(at - 1).is_err(), "from the future");
        let control = Published::new(&["Kim\n".into()], at);
        assert!(control.validate(at).is_err());
        let many = Published::new(&vec!["Kim".to_string(); MAX_NAMES + 1], at);
        assert!(many.validate(at).is_err());
        assert!(serde_json::from_str::<Published>(
            r#"{"schemaVersion":1,"publishedAtMs":1,"names":[],"extra":1}"#
        )
        .is_err());
    }
}
