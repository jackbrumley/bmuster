//! The `tray` check (SPEC-TRAY-SESSIONS 6): for each person signed in at a
//! graphical session, the autostart entry starts the current program, their
//! helper runs, and their session bus has a StatusNotifierWatcher (a tray
//! host). It only reads: files, `/proc` and the bus's name list.

use super::{Context, Outcome};
use crate::tray::starter::{helper_pids, read_tray_users, TrayUser, SESSIONS_DIR};
use std::path::Path;

const WATCHER: &str = "org.kde.StatusNotifierWatcher";

/// What the check found for one person.
#[derive(Debug, Clone)]
pub struct Probe {
    pub user: TrayUser,
    pub helpers: Vec<u32>,
    /// Whether the watcher is on their bus, or why the bus did not answer.
    pub watcher: Result<bool, String>,
}

/// The verdict from the autostart entry's text (or why it could not be
/// read) and each person's probe.
pub fn judge(autostart: &Result<String, String>, probes: &[Probe]) -> Outcome {
    if probes.is_empty() {
        return Outcome::NotApplicable("Nobody is signed in at a graphical session.".into());
    }
    let wanted = format!("{} tray", crate::paths::CURRENT_PROGRAM);
    let mut problems = Vec::new();
    let mut found = Vec::new();
    match autostart {
        Ok(text) => match text.lines().find_map(|line| line.strip_prefix("Exec=")) {
            Some(exec) if exec.trim() == wanted => {
                found.push(format!("The autostart entry starts {wanted}."));
            }
            Some(exec) => problems.push(format!(
                "The autostart entry starts {}, not {wanted} (the agent rewrites it at its next start).",
                exec.trim()
            )),
            None => problems.push("The autostart entry has no Exec line.".into()),
        },
        Err(reason) => problems.push(format!("The autostart entry is missing: {reason}.")),
    }
    for probe in probes {
        let who = format!("{} (uid {})", probe.user.name, probe.user.uid);
        let pids: Vec<String> = probe.helpers.iter().map(u32::to_string).collect();
        let helper = if pids.is_empty() {
            problems.push(format!("{who} has no tray helper running."));
            None
        } else {
            Some(format!("helper running (pid {})", pids.join(", ")))
        };
        let watcher = match &probe.watcher {
            Ok(true) => Some(format!("{WATCHER} on the session bus")),
            Ok(false) => {
                problems.push(format!(
                    "{who}'s session bus has no {WATCHER}, so no tray host shows icons \
                     (on GNOME, turn on the AppIndicator extension)."
                ));
                None
            }
            Err(reason) => {
                problems.push(format!("Could not ask {who}'s session bus: {reason}"));
                None
            }
        };
        if let (Some(helper), Some(watcher)) = (helper, watcher) {
            found.push(format!("{who}: {helper}, {watcher}."));
        }
    }
    if problems.is_empty() {
        Outcome::Pass(found.join(" "))
    } else {
        Outcome::Fail(problems.join(" "))
    }
}

pub fn tray(_: &Context) -> Outcome {
    let autostart = std::fs::read_to_string(crate::tray::linux::AUTOSTART)
        .map_err(|error| format!("{}: {error}", crate::tray::linux::AUTOSTART));
    let quoted = format!("\"{WATCHER}\"");
    let probes: Vec<Probe> = read_tray_users(Path::new(SESSIONS_DIR))
        .into_iter()
        .map(|user| Probe {
            helpers: helper_pids(Path::new("/proc"), user.uid),
            watcher: super::linux::bus_names(user.uid, "ListNames")
                .map(|names| names.contains(&quoted)),
            user,
        })
        .collect();
    judge(&autostart, &probes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(uid: u32, name: &str, helpers: &[u32], watcher: Result<bool, String>) -> Probe {
        Probe {
            user: TrayUser {
                uid,
                name: name.into(),
            },
            helpers: helpers.to_vec(),
            watcher,
        }
    }

    /// SPEC-TRAY-SESSIONS TS8.
    #[test]
    fn tray_check_outcomes() {
        let good = Ok(crate::tray::linux::shortcuts()[0].1.clone());
        assert_eq!(
            judge(&good, &[]),
            Outcome::NotApplicable("Nobody is signed in at a graphical session.".into())
        );

        let Outcome::Pass(detail) = judge(&good, &[probe(1000, "jack", &[4242], Ok(true))]) else {
            panic!("all there passes");
        };
        assert!(detail.contains("starts /opt/bmuster/versions/current/bmuster-agent tray"));
        assert!(detail.contains("jack (uid 1000): helper running (pid 4242)"));
        assert!(detail.contains(WATCHER));

        let old = Ok("[Desktop Entry]\nExec=/opt/bmuster/bmuster-agent tray\n".to_string());
        let outcome = judge(
            &old,
            &[
                probe(1000, "jack", &[], Ok(false)),
                probe(
                    1001,
                    "sam",
                    &[77],
                    Err("busctl ListNames did not answer in 3 s".into()),
                ),
            ],
        );
        let Outcome::Fail(detail) = outcome else {
            panic!("missing pieces fail: {outcome:?}");
        };
        assert!(detail.contains("starts /opt/bmuster/bmuster-agent tray, not"));
        assert!(detail.contains("jack (uid 1000) has no tray helper running."));
        assert!(
            detail.contains("jack (uid 1000)'s session bus has no org.kde.StatusNotifierWatcher")
        );
        assert!(detail.contains("Could not ask sam (uid 1001)'s session bus: busctl"));

        let missing = Err("/etc/xdg/autostart/bmuster-agent.desktop: No such file".to_string());
        let Outcome::Fail(detail) = judge(&missing, &[probe(1000, "jack", &[1], Ok(true))]) else {
            panic!("a missing autostart entry fails");
        };
        assert!(detail.starts_with("The autostart entry is missing"));
    }
}
