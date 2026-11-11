//! Starts the tray helper in every signed-in desktop (SPEC-TRAY-SESSIONS).
//!
//! The root agent reads logind's session records every [`POLL`]. Each real
//! person signed in at a Wayland or X11 desktop gets one helper, started as
//! them in their own systemd user manager ([`start_arguments`]), once their
//! session has been seen for [`SETTLE`](super::starts::SETTLE). A person
//! whose helper already runs (started by the autostart entry or by the
//! agent: [`helper_pids`]) gets nothing, and nobody gets more than one
//! attempt in [`RETRY`](super::starts::RETRY).
//!
//! The only program ever started is [`crate::paths::CURRENT_PROGRAM`] with
//! the one argument `tray`; nothing from the server or the session changes
//! it. The user name comes from logind and must look like an account name.
//! When to start is [`Starter`]'s, shared with Windows (`starts.rs`).

use super::starts::{Desktop, Starter};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::io::Read as _;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// logind's session records (the files `sd-login` reads).
pub const SESSIONS_DIR: &str = "/run/systemd/sessions";
/// The helper's unit in each person's user manager: one name, so systemd
/// refuses a second.
pub const UNIT: &str = "bmuster-tray.service";
/// How often the sessions are read.
pub const POLL: Duration = Duration::from_secs(10);
/// Sign-in screens and first-run setup run as these accounts.
const GREETERS: [&str; 4] = ["gdm", "sddm", "lightdm", "gnome-initial-setup"];
/// The first uid of a person's account (`UID_MIN` in login.defs).
const FIRST_UID: u32 = 1000;
/// `nobody`.
const NOBODY: u32 = 65534;
const SYSTEMD_RUN: &str = "/usr/bin/systemd-run";
/// How long `systemd-run` may take to start the unit.
const START_WAIT: Duration = Duration::from_secs(15);

/// A person signed in at a graphical session.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TrayUser {
    pub uid: u32,
    pub name: String,
}

/// `KEY=VALUE` lines, as logind writes them.
pub(crate) fn fields(text: &str) -> HashMap<&str, &str> {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .collect()
}

/// A plain account name: letters, digits, `_`, `-` and `.`, not starting
/// with `-`, at most 32 bytes. Anything else gets no helper.
fn valid_user_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 32
        && !name.starts_with('-')
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

/// The person a logind session record names, when the session gets a helper.
pub fn session_user(text: &str) -> Option<TrayUser> {
    let fields = fields(text);
    let get = |key: &str| fields.get(key).copied().unwrap_or("");
    let graphical = matches!(get("TYPE"), "wayland" | "x11");
    let live = matches!(get("STATE"), "active" | "online");
    if get("CLASS") != "user" || !graphical || !live {
        return None;
    }
    let uid = get("UID").parse::<u32>().ok()?;
    let name = get("USER");
    if uid < FIRST_UID || uid == NOBODY || GREETERS.contains(&name) || !valid_user_name(name) {
        return None;
    }
    Some(TrayUser {
        uid,
        name: name.to_string(),
    })
}

/// The people the session records name, each once, in uid order.
pub fn tray_users<'a>(records: impl IntoIterator<Item = &'a str>) -> Vec<TrayUser> {
    let mut users: Vec<TrayUser> = records
        .into_iter()
        .filter_map(session_user)
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    users.sort();
    users
}

/// Reads every session record in `dir` (missing: nobody is signed in).
pub fn read_tray_users(dir: &Path) -> Vec<TrayUser> {
    let records: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .collect();
    tray_users(records.iter().map(String::as_str))
}

/// `systemd-run`'s arguments to start the helper in the user manager of
/// whoever runs it: their session's environment, their slice, stopped with
/// their graphical session. It runs as that person, talking to their own
/// bus; `--machine=<user>@.host` relays through a piped bridge that SELinux
/// on Fedora resets ("Connection reset by peer"), as it did `--pipe`.
pub fn start_arguments() -> Vec<OsString> {
    [
        "--user".to_string(),
        "--quiet".to_string(),
        "--collect".to_string(),
        "--service-type=exec".to_string(),
        format!("--unit={UNIT}"),
        "--description=BMuster tray".to_string(),
        "--property=PartOf=graphical-session.target".to_string(),
        "--property=NoNewPrivileges=yes".to_string(),
        "--".to_string(),
        crate::paths::CURRENT_PROGRAM.to_string(),
        "tray".to_string(),
    ]
    .map(OsString::from)
    .to_vec()
}

/// Whether a NUL-separated command line is exactly `<…>/bmuster-agent tray`.
fn is_helper(cmdline: &[u8]) -> bool {
    let mut parts = cmdline
        .strip_suffix(b"\0")
        .unwrap_or(cmdline)
        .split(|byte| *byte == 0);
    let program = parts.next().unwrap_or_default();
    let name = program
        .rsplit(|byte| *byte == b'/')
        .next()
        .unwrap_or_default();
    name == b"bmuster-agent" && parts.next() == Some(b"tray") && parts.next().is_none()
}

/// The real uid on a `/proc/<pid>/status` `Uid:` line.
fn status_uid(status: &str) -> Option<u32> {
    status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|uid| uid.parse().ok())
}

/// The process ids of `uid`'s tray helpers under `proc`, in order.
pub fn helper_pids(proc: &Path, uid: u32) -> Vec<u32> {
    let mut pids: Vec<u32> = std::fs::read_dir(proc)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_str()?.parse::<u32>().ok()?;
            let cmdline = std::fs::read(entry.path().join("cmdline")).ok()?;
            if !is_helper(&cmdline) {
                return None;
            }
            let status = std::fs::read_to_string(entry.path().join("status")).ok()?;
            (status_uid(&status) == Some(uid)).then_some(pid)
        })
        .collect();
    pids.sort_unstable();
    pids
}

/// The machine itself: logind's records, `/proc` and `systemd-run`.
struct System;

impl Desktop for System {
    type Who = TrayUser;

    fn signed_in(&mut self) -> Vec<TrayUser> {
        read_tray_users(Path::new(SESSIONS_DIR))
    }

    fn running(&mut self, user: &TrayUser) -> bool {
        !helper_pids(Path::new("/proc"), user.uid).is_empty()
    }

    fn start(&mut self, user: &TrayUser) -> Result<(), String> {
        use std::os::unix::fs::MetadataExt as _;
        use std::os::unix::process::CommandExt as _;
        let runtime = format!("/run/user/{}", user.uid);
        let folder = std::fs::metadata(&runtime).map_err(|error| format!("{runtime}: {error}"))?;
        if folder.uid() != user.uid {
            return Err(format!("{runtime} does not belong to uid {}", user.uid));
        }
        // As the person (std drops root's supplementary groups with the uid).
        let mut child = Command::new(SYSTEMD_RUN)
            .args(start_arguments())
            .env_clear()
            .env("XDG_RUNTIME_DIR", &runtime)
            .env(
                "DBUS_SESSION_BUS_ADDRESS",
                format!("unix:path={runtime}/bus"),
            )
            .uid(user.uid)
            .gid(folder.gid())
            .current_dir("/")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("could not run {SYSTEMD_RUN}: {error}"))?;
        let mut stderr = child.stderr.take();
        let until = Instant::now() + START_WAIT;
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) if Instant::now() < until => {
                    std::thread::sleep(Duration::from_millis(50));
                }
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "{SYSTEMD_RUN} did not start {UNIT} in {} s",
                        START_WAIT.as_secs()
                    ));
                }
            }
        };
        if status.success() {
            return Ok(());
        }
        let mut errors = String::new();
        if let Some(stderr) = stderr.as_mut() {
            let _ = stderr.take(4096).read_to_string(&mut errors);
        }
        Err(format!(
            "{SYSTEMD_RUN} exited with {status}: {}",
            errors.trim()
        ))
    }
}

/// From the worker's start: on an installed agent running as root from
/// /opt, rewrites the shortcuts that differ and starts the helper in each
/// signed-in desktop until `stop`.
pub fn start(data_dir: &Path, launched: bool, stop: Arc<AtomicBool>) {
    // SAFETY: geteuid has no arguments and cannot fail.
    let root = unsafe { libc::geteuid() } == 0;
    if !root
        || !launched
        || !crate::paths::is_installed_data_dir(data_dir)
        || crate::move_to_opt::pending(data_dir)
        || !Path::new(crate::paths::CURRENT_PROGRAM).exists()
        || !Path::new("/run/systemd/system").is_dir()
    {
        return;
    }
    super::linux::refresh_installed_shortcuts(data_dir);
    let started = std::thread::Builder::new()
        .name("tray sessions".into())
        .spawn(move || {
            let mut starter = Starter::default();
            let mut system = System;
            while !stop.load(Ordering::SeqCst) {
                for attempt in starter.tick(&mut system, Instant::now()) {
                    let who = format!("{} (uid {})", attempt.who.name, attempt.who.uid);
                    match attempt.result {
                        Ok(()) => log::info!("Started the tray for {who}."),
                        Err(reason) if attempt.new_reason => {
                            log::warn!("Could not start the tray for {who}: {reason}");
                        }
                        Err(reason) => {
                            log::debug!("Still cannot start the tray for {who}: {reason}");
                        }
                    }
                }
                std::thread::sleep(POLL);
            }
        });
    if let Err(error) = started {
        log::warn!("Could not start the tray sessions thread: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(fields: &[(&str, &str)]) -> String {
        fields
            .iter()
            .map(|(key, value)| format!("{key}={value}\n"))
            .collect()
    }

    fn desktop(uid: &str, user: &str, kind: &str, state: &str, class: &str) -> String {
        record(&[
            ("# This is private data. Do not parse.", ""),
            ("UID", uid),
            ("USER", user),
            ("ACTIVE", "1"),
            ("STATE", state),
            ("TYPE", kind),
            ("CLASS", class),
            ("SEAT", "seat0"),
        ])
    }

    fn user(uid: u32, name: &str) -> TrayUser {
        TrayUser {
            uid,
            name: name.into(),
        }
    }

    /// SPEC-TRAY-SESSIONS TS1.
    #[test]
    fn which_sessions_get_a_helper() {
        let records = [
            desktop("1000", "jack", "wayland", "active", "user"),
            // A second session of the same person: still one helper.
            desktop("1000", "jack", "x11", "online", "user"),
            desktop("1001", "sam", "x11", "online", "user"),
            desktop("1002", "kim", "tty", "active", "user"),
            desktop("1003", "lee", "wayland", "closing", "user"),
            desktop("1004", "ash", "wayland", "active", "background"),
            desktop("42", "gdm", "wayland", "active", "greeter"),
            desktop("1005", "gdm", "wayland", "active", "user"),
            desktop("1006", "sddm", "x11", "active", "user"),
            desktop("0", "root", "x11", "active", "user"),
            desktop("999", "service", "x11", "active", "user"),
            desktop("65534", "nobody", "x11", "active", "user"),
            desktop("1007", "-rf", "x11", "active", "user"),
            desktop("1008", "a@b", "x11", "active", "user"),
            desktop("1009", "", "x11", "active", "user"),
            desktop("x", "odd", "x11", "active", "user"),
        ];
        let users = tray_users(records.iter().map(String::as_str));
        assert_eq!(users, [user(1000, "jack"), user(1001, "sam")]);

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("3"), &records[0]).unwrap();
        std::fs::write(dir.path().join("c1"), &records[6]).unwrap();
        assert_eq!(read_tray_users(dir.path()), [user(1000, "jack")]);
        assert!(read_tray_users(&dir.path().join("missing")).is_empty());
    }

    /// SPEC-TRAY-SESSIONS TS2.
    #[test]
    fn the_start_command_is_fixed() {
        let arguments: Vec<String> = start_arguments()
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            arguments,
            [
                "--user",
                "--quiet",
                "--collect",
                "--service-type=exec",
                "--unit=bmuster-tray.service",
                "--description=BMuster tray",
                "--property=PartOf=graphical-session.target",
                "--property=NoNewPrivileges=yes",
                "--",
                "/opt/bmuster/versions/current/bmuster-agent",
                "tray",
            ]
        );
        assert_eq!(SYSTEMD_RUN, "/usr/bin/systemd-run");
    }

    fn process(proc: &Path, pid: u32, uid: u32, cmdline: &[u8]) {
        let dir = proc.join(pid.to_string());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("cmdline"), cmdline).unwrap();
        std::fs::write(
            dir.join("status"),
            format!("Name:\tbmuster-agent\nUid:\t{uid}\t{uid}\t{uid}\t{uid}\n"),
        )
        .unwrap();
    }

    /// SPEC-TRAY-SESSIONS TS5.
    #[test]
    fn finds_the_helper_in_proc() {
        let proc = tempfile::tempdir().unwrap();
        let proc = proc.path();
        process(
            proc,
            4242,
            1000,
            b"/opt/bmuster/versions/current/bmuster-agent\0tray\0",
        );
        // An autostart entry from 0.3.2 starts the rescue copy.
        process(proc, 4300, 1000, b"/opt/bmuster/bmuster-agent\0tray\0");
        process(
            proc,
            4301,
            1000,
            b"/opt/bmuster/bmuster-agent\0tray\0--open\0",
        );
        process(proc, 4302, 1000, b"/usr/bin/other-agent\0tray\0");
        process(
            proc,
            4303,
            0,
            b"/opt/bmuster/versions/current/bmuster-agent\0launch\0",
        );
        process(proc, 4304, 1001, b"/opt/bmuster/bmuster-agent\0tray\0");
        process(proc, 4305, 1000, b"/opt/bmuster/not-bmuster-agent\0tray\0");
        std::fs::create_dir_all(proc.join("self")).unwrap();
        assert_eq!(helper_pids(proc, 1000), [4242, 4300]);
        assert_eq!(helper_pids(proc, 1001), [4304]);
        assert!(helper_pids(proc, 1002).is_empty());
        assert!(helper_pids(&proc.join("missing"), 1000).is_empty());
    }
}
