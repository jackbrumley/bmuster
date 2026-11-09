//! Checks that failed with a permission denial run once per agent version
//! (SPEC-SESSION-UNITS, Version 3, design 7). On Fedora every SELinux
//! denial raises a desktop alert at the machine, so a machine at a policy
//! wall must not get one every six hours. The result stays in the report,
//! marked as not run again, and the next version runs the check afresh.

use super::{run_all, Check, Context};
use crate::identity::write_private;
use bmuster_protocol::checks::MAX_CHECK_DETAIL_BYTES;
use bmuster_protocol::checks::{CheckResult, CheckStatus};
use bmuster_protocol::logs::cut_text;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

/// In the data folder: the denied checks of one version.
const FILE: &str = "checks-denied.json";
/// What a failure's detail says when the operating system refused.
const DENIALS: [&str; 6] = [
    "permission denied",
    "operation not permitted",
    "access denied",
    "avc:  denied",
    "avc: denied",
    "203/exec",
];
/// Starts the detail of a result that was kept instead of run.
pub const NOT_RUN_AGAIN: &str =
    "Not run again until the next agent version: it failed with a permission denial. ";

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Saved {
    version: String,
    results: Vec<CheckResult>,
}

/// The denied checks of the running version, kept in the data folder.
pub struct Denied {
    path: PathBuf,
    version: String,
}

impl Denied {
    pub fn new(data_dir: &std::path::Path, version: &str) -> Self {
        Self {
            path: data_dir.join(FILE),
            version: version.to_string(),
        }
    }

    /// The saved results; none when they belong to another version.
    fn load(&self) -> Vec<CheckResult> {
        let Ok(text) = fs::read_to_string(&self.path) else {
            return Vec::new();
        };
        match serde_json::from_str::<Saved>(&text) {
            Ok(saved) if saved.version == self.version => saved.results,
            Ok(_) => Vec::new(),
            Err(error) => {
                log::warn!("{} is damaged ({error}); ignoring it.", self.path.display());
                Vec::new()
            }
        }
    }

    fn save(&self, results: Vec<CheckResult>) {
        let saved = Saved {
            version: self.version.clone(),
            results,
        };
        let written = serde_json::to_vec_pretty(&saved)
            .map_err(anyhow::Error::from)
            .and_then(|json| write_private(&self.path, &json));
        if let Err(error) = written {
            log::warn!("Could not save the denied checks: {error:#}");
        }
    }

    /// [`run_all`], except for checks this version saw denied: their saved
    /// result stands in. New denials are saved.
    pub fn run(
        &self,
        checks: &[Check],
        context: &Context,
        deadline: Duration,
        run_deadline: Duration,
    ) -> Vec<CheckResult> {
        let mut saved = self.load();
        let to_run: Vec<Check> = checks
            .iter()
            .filter(|check| !saved.iter().any(|kept| kept.id == check.id))
            .copied()
            .collect();
        let ran = run_all(&to_run, context, deadline, run_deadline);
        let machine_denied = ran.iter().any(reports_denials);
        let mut added = false;
        for result in &ran {
            if result.status == CheckStatus::Fail && (machine_denied || is_denial(&result.detail)) {
                let mut kept = result.clone();
                kept.detail = cut_text(
                    &format!("{NOT_RUN_AGAIN}{}", result.detail),
                    MAX_CHECK_DETAIL_BYTES,
                );
                saved.push(kept);
                added = true;
            }
        }
        if added {
            self.save(saved.clone());
        }
        checks
            .iter()
            .filter_map(|check| {
                ran.iter()
                    .find(|result| result.id == check.id)
                    .or_else(|| saved.iter().find(|kept| kept.id == check.id))
                    .cloned()
            })
            .collect()
    }
}

pub(super) fn is_denial(detail: &str) -> bool {
    let detail = detail.to_ascii_lowercase();
    DENIALS.iter().any(|marker| detail.contains(marker))
}

/// The `audit` check found denials in this run's window: the run's other
/// failures are what the policy refused.
fn reports_denials(result: &CheckResult) -> bool {
    result.id == "audit"
        && result.status == CheckStatus::Pass
        && !result.detail.starts_with("No denials")
}
