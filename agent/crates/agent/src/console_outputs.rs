//! The Windows display report's DXGI outputs (SPEC-DIAGNOSTICS, Windows
//! outputs). The service runs in session 0, where DXGI lists no outputs
//! because the monitors belong to the console session. So the service
//! starts `desktop-helper --outputs <file>` in the console session, the way
//! the checks start `--check`: the helper lists the outputs, writes them (or
//! why it could not) to the file and exits; the service reads and deletes
//! the file.
//!
//! Outputs are inventory, not live state: one reading is kept until the
//! console session changes or [`READ_EVERY`] passes, and a failed one is
//! tried again after [`RETRY_AFTER`]. The pure parts (the file's parsing
//! and the cache) build and are tested everywhere.

use bmuster_protocol::{DxgiOutput, DxgiOutputs};
use std::time::{Duration, Instant};

/// How long a reading is kept while the console session stays the same.
pub const READ_EVERY: Duration = Duration::from_secs(60 * 60);
/// How long a failed reading is kept before the helper runs again.
pub const RETRY_AFTER: Duration = Duration::from_secs(5 * 60);
/// The server takes at most this many outputs.
const MAX_OUTPUTS: usize = 32;
/// The server takes names of at most 255 characters.
const MAX_TEXT: usize = 255;
/// The server takes reasons of at most 500 characters.
const MAX_REASON: usize = 500;

fn cut(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

/// A failed reading, with its reason cut to what the server takes.
pub fn failed(reason: &str) -> DxgiOutputs {
    DxgiOutputs::Failed {
        reason: cut(reason, MAX_REASON),
    }
}

/// The helper's file as outputs, within the server's limits. A file that
/// is not the helper's answer is a failure saying so, never an empty list.
pub fn from_helper_file(bytes: &[u8]) -> DxgiOutputs {
    match serde_json::from_slice::<DxgiOutputs>(bytes) {
        Ok(DxgiOutputs::Read { list }) => DxgiOutputs::Read {
            list: list
                .into_iter()
                .take(MAX_OUTPUTS)
                .map(|output| DxgiOutput {
                    adapter: cut(&output.adapter, MAX_TEXT),
                    name: cut(&output.name, MAX_TEXT),
                    ..output
                })
                .collect(),
        },
        Ok(DxgiOutputs::Failed { reason }) => failed(&reason),
        Err(error) => failed(&format!(
            "The display helper's answer was unreadable: {error}"
        )),
    }
}

struct Reading {
    session: u32,
    at: Instant,
    outputs: DxgiOutputs,
}

/// The last reading, and when to take a new one.
pub struct Cache {
    last: Option<Reading>,
}

impl Cache {
    pub const fn new() -> Self {
        Self { last: None }
    }

    /// The outputs for console session `session`: the kept reading while it
    /// is fresh, otherwise `read()`'s.
    pub fn get(
        &mut self,
        session: u32,
        now: Instant,
        read: impl FnOnce() -> DxgiOutputs,
    ) -> DxgiOutputs {
        let fresh = self.last.as_ref().is_some_and(|last| {
            let keep = match last.outputs {
                DxgiOutputs::Read { .. } => READ_EVERY,
                DxgiOutputs::Failed { .. } => RETRY_AFTER,
            };
            last.session == session && now.saturating_duration_since(last.at) < keep
        });
        match &self.last {
            Some(last) if fresh => last.outputs.clone(),
            _ => {
                let outputs = read();
                self.last = Some(Reading {
                    session,
                    at: now,
                    outputs: outputs.clone(),
                });
                outputs
            }
        }
    }
}

#[cfg(windows)]
static CACHE: std::sync::Mutex<Cache> = std::sync::Mutex::new(Cache::new());

/// How long the service waits for the helper.
#[cfg(windows)]
const HELPER_WAIT: Duration = Duration::from_secs(10);

/// The console session's outputs, from the cache or a new helper run. The
/// lock is held during a run, so two callers never start two helpers.
#[cfg(windows)]
pub fn console_outputs(session: u32) -> DxgiOutputs {
    let mut cache = CACHE.lock().unwrap_or_else(|p| p.into_inner());
    cache.get(session, Instant::now(), || match run_helper(session) {
        Ok(outputs) => outputs,
        Err(reason) => {
            log::warn!("Could not read the display outputs: {reason}");
            failed(&reason)
        }
    })
}

/// Starts `desktop-helper --outputs <file>` in the console session and
/// reads what it wrote.
#[cfg(windows)]
fn run_helper(session: u32) -> Result<DxgiOutputs, String> {
    use bmuster_desktop::winsession::{command_line::quote, follow::NO_CONSOLE_SESSION, launch};
    if session == NO_CONSOLE_SESSION || session == 0 {
        return Err("No session is attached to the console.".into());
    }
    let data_dir =
        crate::paths::default_data_dir().map_err(|e| format!("No data folder: {e:#}"))?;
    let program =
        std::env::current_exe().map_err(|e| format!("Cannot find this program's path: {e}"))?;
    let dir = data_dir.join("checks");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let out = dir.join(format!("outputs-{}.json", std::process::id()));
    let _ = std::fs::remove_file(&out);
    let line = format!(
        "{} desktop-helper --outputs {} --data-dir {}",
        quote(&program.to_string_lossy()),
        quote(&out.to_string_lossy()),
        quote(&data_dir.to_string_lossy()),
    );
    let job = launch::Job::new()?;
    let process = launch::start_in_session(session, &line, &job)?;
    if !process.wait(HELPER_WAIT) {
        process.kill();
        let _ = std::fs::remove_file(&out);
        return Err(format!(
            "The display helper did not answer in {} s.",
            HELPER_WAIT.as_secs()
        ));
    }
    let code = process.exit_code();
    let bytes = std::fs::read(&out);
    let _ = std::fs::remove_file(&out);
    match (code, bytes) {
        (Some(0), Ok(bytes)) => Ok(from_helper_file(&bytes)),
        (code, _) => Err(format!(
            "The display helper exited with code {code:?} without an answer; desktop-helper.log says why."
        )),
    }
}

/// `desktop-helper --outputs <out>`: this console session's DXGI outputs,
/// or why DXGI could not list them, written to `out` as JSON.
#[cfg(windows)]
pub fn write_outputs(out: &std::path::Path) -> anyhow::Result<()> {
    use anyhow::Context as _;
    bmuster_desktop::winsession::prepare_helper_process();
    let outputs = match bmuster_desktop::capture::dxgi::outputs() {
        Ok(list) => DxgiOutputs::Read {
            list: list
                .into_iter()
                .map(|output| DxgiOutput {
                    adapter: output.adapter,
                    name: output.name,
                    width: output.width,
                    height: output.height,
                    rotation: output.rotation,
                })
                .collect(),
        },
        Err(error) => failed(&format!("DXGI could not list the outputs: {error}")),
    };
    crate::identity::write_private(out, &serde_json::to_vec(&outputs)?)
        .with_context(|| format!("could not write {}", out.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(name: &str) -> DxgiOutput {
        DxgiOutput {
            adapter: "Intel(R) UHD Graphics 620".into(),
            name: name.into(),
            width: 1920,
            height: 1080,
            rotation: 0,
        }
    }

    /// SPEC-DIAGNOSTICS DW1.
    #[test]
    fn helper_file_is_parsed() {
        let read = DxgiOutputs::Read {
            list: vec![output("\\\\.\\DISPLAY1"), output("\\\\.\\DISPLAY2")],
        };
        assert_eq!(from_helper_file(&serde_json::to_vec(&read).unwrap()), read);
        let none = DxgiOutputs::Read { list: vec![] };
        assert_eq!(from_helper_file(&serde_json::to_vec(&none).unwrap()), none);
        assert_eq!(
            from_helper_file(br#"{"kind":"failed","reason":"DXGI_ERROR_ACCESS_LOST"}"#),
            failed("DXGI_ERROR_ACCESS_LOST")
        );
        let DxgiOutputs::Failed { reason } = from_helper_file(b"not json") else {
            panic!("a garbled file must be a failure");
        };
        assert!(reason.starts_with("The display helper's answer was unreadable"));
        let DxgiOutputs::Failed { reason } = from_helper_file(b"[]") else {
            panic!("the old bare list is not the helper's answer");
        };
        assert!(!reason.is_empty());

        // Within the server's limits: 32 outputs, 255-character names,
        // 500-character reasons.
        let long = "x".repeat(400);
        let many = DxgiOutputs::Read {
            list: (0..40).map(|_| output(&long)).collect(),
        };
        let DxgiOutputs::Read { list } = from_helper_file(&serde_json::to_vec(&many).unwrap())
        else {
            panic!("expected a list");
        };
        assert_eq!(list.len(), 32);
        assert!(list.iter().all(|o| o.name.chars().count() == 255));
        let DxgiOutputs::Failed { reason } = failed(&"y".repeat(900)) else {
            panic!("expected a failure");
        };
        assert_eq!(reason.chars().count(), 500);
    }

    /// SPEC-DIAGNOSTICS DW2.
    #[test]
    fn outputs_are_cached() {
        let mut cache = Cache::new();
        let start = Instant::now();
        let runs = std::cell::Cell::new(0);
        let read = |cache: &mut Cache, session: u32, at: Duration, answer: DxgiOutputs| {
            cache.get(session, start + at, || {
                runs.set(runs.get() + 1);
                answer
            })
        };
        let one = DxgiOutputs::Read {
            list: vec![output("\\\\.\\DISPLAY1")],
        };
        let two = DxgiOutputs::Read {
            list: vec![output("\\\\.\\DISPLAY2")],
        };
        // The first call reads; within the hour the reading is kept.
        assert_eq!(read(&mut cache, 1, Duration::ZERO, one.clone()), one);
        assert_eq!(
            read(
                &mut cache,
                1,
                READ_EVERY - Duration::from_secs(1),
                two.clone()
            ),
            one
        );
        // A new console session reads again at once.
        assert_eq!(
            read(&mut cache, 2, Duration::from_secs(60), two.clone()),
            two
        );
        // After the hour it reads again.
        let later = Duration::from_secs(60) + READ_EVERY;
        assert_eq!(read(&mut cache, 2, later, one.clone()), one);
        // A failure is kept for five minutes, then tried again.
        let broken = failed("The display helper did not answer in 10 s.");
        assert_eq!(read(&mut cache, 3, later, broken.clone()), broken);
        assert_eq!(
            read(
                &mut cache,
                3,
                later + RETRY_AFTER - Duration::from_secs(1),
                one.clone()
            ),
            broken
        );
        assert_eq!(read(&mut cache, 3, later + RETRY_AFTER, one.clone()), one);
        assert_eq!(runs.get(), 5);
    }
}
