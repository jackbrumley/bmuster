//! Local page events waiting for the server (SPEC-AGENT-LOCAL 7): kept in
//! `local-events.json` (owner-only) so they survive a restart and a server
//! that is away, at most [`MAX_EVENTS`], and sent signed when it answers.

use crate::client::{Reply, Session};
use crate::identity::{check_private, write_private};
use crate::paths::LOCAL_EVENTS_FILE;
use anyhow::{bail, Context as _, Result};
use bmuster_protocol::{LocalEvent, LocalEventEntry, LocalEventsReport, LOCAL_EVENTS_PATH};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

/// Events kept while the server is away; beyond this the oldest go, counted
/// in a `dropped` marker at the front.
pub const MAX_EVENTS: usize = 500;
/// Events per request.
const BATCH: usize = 100;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Queue {
    next_seq: u64,
    events: Vec<LocalEventEntry>,
}

impl Queue {
    fn push(&mut self, event: LocalEvent, at_ms: u64) {
        // Sequence numbers start from the clock, so a lost or new file still
        // numbers above everything the server has seen from this machine.
        let seq = self.next_seq.max(at_ms);
        self.next_seq = seq + 1;
        let marked = matches!(
            self.events.first(),
            Some(LocalEventEntry {
                event: LocalEvent::Dropped { .. },
                ..
            })
        );
        let real = self.events.len() - usize::from(marked);
        if real >= MAX_EVENTS {
            if marked {
                let oldest = self.events.remove(1);
                let marker = &mut self.events[0];
                if let LocalEvent::Dropped { count } = &mut marker.event {
                    *count += 1;
                }
                marker.seq = oldest.seq;
                marker.at_ms = oldest.at_ms;
            } else {
                self.events[0].event = LocalEvent::Dropped { count: 1 };
            }
        }
        self.events.push(LocalEventEntry { seq, at_ms, event });
    }
}

pub struct Journal {
    path: PathBuf,
    queue: Mutex<Queue>,
    /// One send at a time.
    sending: Mutex<()>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

impl Journal {
    /// Reads the waiting events from the data folder. A damaged file is set
    /// aside (renamed `.damaged`) rather than stopping the page.
    pub fn open(dir: &Path) -> Self {
        let path = dir.join(LOCAL_EVENTS_FILE);
        let queue = if path.exists() {
            match read(&path) {
                Ok(queue) => queue,
                Err(e) => {
                    log::warn!("Local page: {e:#}; starting a new event queue.");
                    let _ = fs::rename(&path, path.with_extension("damaged"));
                    Queue::default()
                }
            }
        } else {
            Queue::default()
        };
        Self {
            path,
            queue: Mutex::new(queue),
            sending: Mutex::new(()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Queue> {
        // panic = "abort": a poisoned lock cannot hold half-made changes.
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn save(&self, queue: &Queue) {
        let written = serde_json::to_vec(queue)
            .context("could not encode the event queue")
            .and_then(|bytes| write_private(&self.path, &bytes));
        if let Err(e) = written {
            log::warn!("Local page: could not save its event queue: {e:#}");
        }
    }

    pub fn record(&self, event: LocalEvent) {
        self.record_at(event, now_ms());
    }

    pub fn record_at(&self, event: LocalEvent, at_ms: u64) {
        let mut queue = self.lock();
        queue.push(event, at_ms);
        self.save(&queue);
    }

    pub fn pending(&self) -> bool {
        !self.lock().events.is_empty()
    }

    /// Sends everything waiting, in batches; each batch the server takes is
    /// removed. Returns how many were sent. Waits for a send already running,
    /// then sends whatever it left.
    pub fn send(&self, session: &Session) -> Result<usize> {
        let _sending = self
            .sending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut sent = 0;
        loop {
            let batch: Vec<LocalEventEntry> =
                self.lock().events.iter().take(BATCH).cloned().collect();
            let Some(last) = batch.last().map(|entry| entry.seq) else {
                return Ok(sent);
            };
            let body = serde_json::to_vec(&LocalEventsReport {
                sent_at_ms: now_ms(),
                events: batch.clone(),
            })?;
            match session.post_signed::<serde::de::IgnoredAny>(LOCAL_EVENTS_PATH, &body)? {
                Reply::Ok(_) => {}
                Reply::Refused(refusal) => bail!("{} ({})", refusal.message, refusal.reason),
            }
            let mut queue = self.lock();
            queue.events.retain(|entry| entry.seq > last);
            self.save(&queue);
            sent += batch.len();
        }
    }

    #[cfg(test)]
    pub fn entries(&self) -> Vec<LocalEventEntry> {
        self.lock().events.clone()
    }
}

fn read(path: &Path) -> Result<Queue> {
    check_private(path)?;
    let bytes = fs::read(path).with_context(|| format!("could not read {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("{} is damaged", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bmuster_protocol::CodeOwners;

    const AT: u64 = 2_000_000_000_000;

    #[test]
    fn events_survive_a_restart_privately_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path());
        assert!(!journal.pending());
        journal.record_at(LocalEvent::WrongCode, AT);
        journal.record_at(
            LocalEvent::SignedIn {
                codes: CodeOwners::Machine,
            },
            AT + 5,
        );
        check_private(&dir.path().join(LOCAL_EVENTS_FILE)).unwrap();

        let again = Journal::open(dir.path());
        let entries = again.entries();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].seq, AT);
        assert_eq!(entries[0].event, LocalEvent::WrongCode);
        assert_eq!(entries[1].at_ms, AT + 5);
        // Numbers keep rising after a restart, even with the clock behind.
        again.record_at(LocalEvent::LockedOut, AT - 60_000);
        assert_eq!(again.entries()[2].seq, AT + 6);
    }

    /// E1: at most 500 events; the oldest go, counted in one marker.
    #[test]
    fn a_full_queue_drops_the_oldest_and_counts_them() {
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path());
        for n in 0..MAX_EVENTS as u64 + 3 {
            journal.record_at(LocalEvent::WrongCode, AT + n);
        }
        let entries = journal.entries();
        assert_eq!(entries.len(), MAX_EVENTS + 1, "500 events and the marker");
        assert_eq!(entries[0].event, LocalEvent::Dropped { count: 3 });
        assert!(entries[0].seq < entries[1].seq, "the marker stays first");
        assert_eq!(entries[1].seq, AT + 3);
        assert_eq!(entries.last().unwrap().seq, AT + MAX_EVENTS as u64 + 2);
        assert_eq!(
            Journal::open(dir.path()).entries()[0].event,
            LocalEvent::Dropped { count: 3 }
        );
    }

    fn session(url: &str) -> Session {
        use crate::client::{Security, ServerUrl, TlsMode, Transport};
        let transport = Transport::new(
            ServerUrl::parse(url).unwrap(),
            Security::once(TlsMode::Checked(bmuster_protocol::ServerTrust::Public)),
        );
        Session::new(
            transport,
            "m-1".into(),
            ed25519_dalek::SigningKey::from_bytes(&[1; 32]),
        )
    }

    #[test]
    fn sending_empties_the_queue_in_batches() {
        use crate::relocate::tests::{fake_server, Seen};
        let seen = Seen::default();
        let url = fake_server("server", 200, r#"{"recorded":150}"#, &seen);
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path());
        for n in 0..150 {
            journal.record_at(LocalEvent::WrongCode, AT + n);
        }
        assert_eq!(journal.send(&session(&url)).unwrap(), 150);
        assert!(!journal.pending());
        assert_eq!(
            *seen.lock().unwrap(),
            [
                "server POST /agent/v1/local-events",
                "server POST /agent/v1/local-events"
            ]
        );
        assert!(!Journal::open(dir.path()).pending(), "saved empty");
    }

    #[test]
    fn a_refused_send_keeps_the_events() {
        use crate::relocate::tests::{fake_server, Seen};
        let seen = Seen::default();
        let url = fake_server(
            "server",
            400,
            r#"{"reason":"bad-request","message":"no"}"#,
            &seen,
        );
        let dir = tempfile::tempdir().unwrap();
        let journal = Journal::open(dir.path());
        journal.record_at(LocalEvent::LockedOut, AT);
        assert!(journal.send(&session(&url)).is_err());
        assert!(journal.pending());
    }

    #[test]
    fn a_damaged_queue_is_set_aside() {
        let dir = tempfile::tempdir().unwrap();
        write_private(&dir.path().join(LOCAL_EVENTS_FILE), b"{").unwrap();
        let journal = Journal::open(dir.path());
        assert!(!journal.pending());
        assert!(dir.path().join("local-events.damaged").exists());
    }
}
