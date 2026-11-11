//! Starting the cleaner (SPEC-STORAGE 11.4), from the agent's storage
//! scheduler, which looks every half second. A clean-up asked for on a
//! files session waits in `cleanup-wanted`; this starts
//! `bmuster-agent storage-clean` for it (a transient unit on an installed
//! Linux agent, outside the agent's sandbox; a child otherwise) and stops it
//! when the agent stops.

use super::super::schedule::{launch, Pass};
use super::{cleaner_running, load_run, path, WANTED_FILE};
use crate::exec::placement::SessionMode;
use bmuster_protocol::cleanup::CleanupRun;
use std::ffi::OsString;
use std::path::Path;
use std::time::Duration;

/// A request still empty after this was left by a start that failed half way.
const STALE: Duration = Duration::from_secs(60);

pub fn arguments(data_dir: &Path) -> Vec<OsString> {
    vec![
        "storage-clean".into(),
        "--data-dir".into(),
        data_dir.as_os_str().to_os_string(),
    ]
}

/// What the request file says now.
#[derive(Debug, PartialEq, Eq)]
pub enum Waiting {
    Nothing,
    /// A run, written in full, that no cleaner has taken.
    Ready(String),
    /// Being written, or left half written.
    NotYet {
        stale: bool,
    },
}

pub fn waiting(data_dir: &Path) -> Waiting {
    let request = path(data_dir, WANTED_FILE);
    let Ok(run_id) = std::fs::read_to_string(&request) else {
        return Waiting::Nothing;
    };
    let written = matches!(
        load_run(data_dir),
        CleanupRun::Running { run_id: ref listed, .. } if *listed == run_id
    );
    if !run_id.is_empty() && written && !cleaner_running(data_dir) {
        return Waiting::Ready(run_id);
    }
    let stale = std::fs::metadata(&request)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age > STALE);
    Waiting::NotYet { stale }
}

/// The cleaner this agent started, if one runs.
#[derive(Default)]
pub struct Launcher {
    running: Option<(String, Pass)>,
}

fn drop_request(data_dir: &Path, why: &str) {
    log::warn!("Storage clean-up: {why}; the request is dropped.");
    let _ = std::fs::remove_file(path(data_dir, WANTED_FILE));
}

impl Launcher {
    /// Starts a waiting clean-up; notices one that ended.
    pub fn tick(&mut self, data_dir: &Path, mode: SessionMode) {
        if let Some((run_id, pass)) = &mut self.running {
            if !pass.finished() {
                return;
            }
            // It ended without taking the request: it could not start.
            if std::fs::read_to_string(path(data_dir, WANTED_FILE))
                .ok()
                .as_ref()
                == Some(run_id)
            {
                drop_request(data_dir, "the cleaner ended before it started");
            }
            self.running = None;
        }
        match waiting(data_dir) {
            Waiting::Nothing | Waiting::NotYet { stale: false } => {}
            Waiting::NotYet { stale: true } => {
                drop_request(data_dir, "a request was left half written")
            }
            Waiting::Ready(run_id) => {
                match launch(arguments(data_dir), "clean", "storage clean-up", mode) {
                    Ok(pass) => self.running = Some((run_id, pass)),
                    Err(e) => drop_request(data_dir, &format!("{e:#}")),
                }
            }
        }
    }

    /// Stops a cleaner that is running (the agent is stopping).
    pub fn stop(self) {
        if let Some((_, pass)) = self.running {
            pass.stop();
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::super::items::{LinuxFolders, Machine};
    use super::*;
    use bmuster_protocol::cleanup::CleanupItem;

    #[test]
    fn s18_a_written_request_is_ready_once() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let root = dir.path().join("machine");
        std::fs::create_dir_all(root.join("var/crash")).unwrap();
        assert_eq!(waiting(&data), Waiting::Nothing);
        let machine = Machine::Linux(LinuxFolders { root });
        let run = "0f8fad5b-d9cb-469f-a165-70867728950e";
        super::super::start_on(
            &data,
            Some(&machine),
            run,
            &[CleanupItem::LinuxCrashDumps],
            1,
        )
        .unwrap();
        assert_eq!(waiting(&data), Waiting::Ready(run.into()));
        std::fs::write(path(&data, WANTED_FILE), b"").unwrap();
        assert_eq!(waiting(&data), Waiting::NotYet { stale: false });
        assert_eq!(
            arguments(Path::new("/var/lib/bmuster")),
            ["storage-clean", "--data-dir", "/var/lib/bmuster"].map(OsString::from)
        );
    }
}
