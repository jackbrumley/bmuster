//! The Windows tray starter's decisions (SPEC-TRAY-SESSIONS, Windows): which
//! sessions get a helper, which token it runs with, which program and fixed
//! command line, which running processes are older helpers, when a running
//! helper bows out for a new program, and when it tries to show its icon
//! again. Pure, so the tests run on every build machine; the Win32 calls are
//! in `windows_starter.rs` and `windows.rs`.

use bmuster_desktop::winsession::command_line::quote;
use std::time::Duration;

/// The sign-in entry 0.4.19 and earlier wrote, which ran the rescue copy
/// with a console window; the agent removes it (SPEC-TRAY-SESSIONS,
/// Windows version 2).
pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
pub const RUN_VALUE: &str = "BMusterAgent";

/// How often the Windows starter lists the sessions.
pub const POLL: Duration = Duration::from_secs(2);
/// How long a Windows session is seen before its first helper starts.
pub const SETTLE: Duration = Duration::from_secs(5);

/// Every tray copy's name starts with this.
const TRAY_PREFIX: &str = "bmuster-tray-";

/// This version's tray program in the program folder: its own copy, so
/// the tray always runs the agent's current version.
pub fn tray_file_name(version: &str) -> String {
    format!("{TRAY_PREFIX}{version}.exe")
}

/// Whether a program or file named `name` is a tray copy (of any version,
/// or one's leftover).
pub fn is_tray_file(name: &str) -> bool {
    name.to_ascii_lowercase().starts_with(TRAY_PREFIX)
}

/// Whether `name`, a file in the program folder, is a tray copy (or one's
/// leftover `.new` or `.old`) other than `current`: removed when not in use.
pub fn is_other_tray_file(name: &str, current: &str) -> bool {
    is_tray_file(name) && !name.eq_ignore_ascii_case(current)
}

/// The folder and the last part of a Windows path.
fn split(path: &str) -> (&str, &str) {
    match path.rfind('\\') {
        Some(at) => (&path[..at], &path[at + 1..]),
        None => ("", path),
    }
}

/// What a process in a signed-in session is to the starter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Helper {
    /// This version's tray copy.
    Current,
    /// An older (or other) tray: ended so the current one can start.
    Stale,
    /// Not a BMuster tray; never touched.
    Other,
}

/// What a process whose program is `image` is, given this version's tray
/// copy `tray` and the rescue copy `rescue` (full paths in the program
/// folder). `elevated` is `None` when it could not be read. The rescue copy
/// unelevated is a helper from 0.4.19 or earlier; elevated (or unknown) it
/// is an administrator's own command and is left alone.
pub fn helper_kind(image: &str, tray: &str, rescue: &str, elevated: Option<bool>) -> Helper {
    if image.eq_ignore_ascii_case(tray) {
        return Helper::Current;
    }
    let (folder, name) = split(image);
    let (program_folder, _) = split(tray);
    if !folder.is_empty() && folder.eq_ignore_ascii_case(program_folder) && is_tray_file(name) {
        return Helper::Stale;
    }
    if image.eq_ignore_ascii_case(rescue) && elevated == Some(false) {
        return Helper::Stale;
    }
    Helper::Other
}

/// What wakes the helper's window, for its notification icon.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconEvent {
    /// The helper has just made its window.
    Start,
    /// Explorer (re)made the taskbar: any icon it had is gone.
    TaskbarCreated,
    /// The once-a-second timer that keeps the icon current.
    Tick,
    /// The retry timer, running while the icon is not shown.
    Retry,
}

/// What the helper asks `Shell_NotifyIconW` for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconCall {
    Add,
    Modify,
    Nothing,
}

/// How often the helper tries again to add its icon.
pub const ICON_RETRY: Duration = Duration::from_secs(2);

/// The call for `event` while the icon is (`shown`) or is not shown. After
/// an `Add` the retry timer runs exactly while the icon is not shown.
pub fn icon_call(shown: bool, event: IconEvent) -> IconCall {
    match event {
        IconEvent::Start | IconEvent::TaskbarCreated => IconCall::Add,
        IconEvent::Retry if shown => IconCall::Nothing,
        IconEvent::Retry => IconCall::Add,
        IconEvent::Tick if shown => IconCall::Modify,
        IconEvent::Tick => IconCall::Nothing,
    }
}

/// The helper's single-instance mutex. `Local\` names live in the
/// session's own namespace, so there is one helper per session.
pub const MUTEX_NAME: &str = r"Local\BMusterTray";

/// `WTS_CONNECTSTATE_CLASS`: someone is using the session at the screen or
/// over Remote Desktop.
pub const WTS_ACTIVE: i32 = 0;
/// `WTS_CONNECTSTATE_CLASS`: a client is connected to the session.
pub const WTS_CONNECTED: i32 = 1;

/// One session as `WTSEnumerateSessionsW` and `WTSQuerySessionInformationW`
/// describe it.
#[derive(Debug, Clone)]
pub struct SessionRecord {
    pub id: u32,
    /// Its `WTS_CONNECTSTATE_CLASS`.
    pub state: i32,
    /// Who is signed in to it (`jack`, `CORP\jack`); `None` at the sign-in
    /// screen.
    pub user: Option<String>,
}

/// A session that gets a tray helper, and who is signed in to it (for the
/// log only: the helper runs with the session's own token).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TraySession {
    pub id: u32,
    pub user: String,
}

/// The sessions that get a helper, each once, in id order: active or
/// connected, someone signed in, and never session 0 (services, no screen).
/// A disconnected session waits until its person comes back.
pub fn tray_sessions(records: &[SessionRecord]) -> Vec<TraySession> {
    let mut sessions: Vec<TraySession> = records
        .iter()
        .filter(|record| record.id != 0)
        .filter(|record| matches!(record.state, WTS_ACTIVE | WTS_CONNECTED))
        .filter_map(|record| {
            let user = record.user.as_deref()?.trim();
            (!user.is_empty()).then(|| TraySession {
                id: record.id,
                user: user.to_string(),
            })
        })
        .collect();
    sessions.sort();
    sessions.dedup_by_key(|session| session.id);
    sessions
}

/// Which of the session's tokens starts the helper.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenUse {
    /// The token `WTSQueryUserToken` gave: not elevated (UAC's filtered
    /// token, or a standard account).
    AsGiven,
    /// The token is the elevated half of an administrator's pair: use its
    /// linked, filtered token instead, so the tray never runs elevated.
    Linked,
}

/// `TOKEN_ELEVATION_TYPE` values.
const ELEVATION_DEFAULT: i32 = 1;
const ELEVATION_FULL: i32 = 2;
const ELEVATION_LIMITED: i32 = 3;

/// The token to use for a session token of `elevation_type`; `None` (no
/// helper) for a value Windows does not define.
pub fn token_use(elevation_type: i32) -> Option<TokenUse> {
    match elevation_type {
        ELEVATION_DEFAULT | ELEVATION_LIMITED => Some(TokenUse::AsGiven),
        ELEVATION_FULL => Some(TokenUse::Linked),
        _ => None,
    }
}

/// Whether the token's user is a person: a local, Microsoft or domain
/// account (`S-1-5-21-…`) or a Microsoft Entra account (`S-1-12-1-…`).
/// Never SYSTEM, LOCAL SERVICE, NETWORK SERVICE or any other built-in
/// account, so the helper cannot start with a service's rights.
pub fn is_person_sid(sid: &str) -> bool {
    ["S-1-5-21-", "S-1-12-1-"].iter().any(|prefix| {
        sid.strip_prefix(prefix).is_some_and(|rest| {
            !rest.is_empty() && rest.split('-').all(|part| part.parse::<u32>().is_ok())
        })
    })
}

/// The helper's command line: the tray program, quoted, and `tray`.
pub fn command_line(program: &str) -> String {
    format!("{} tray", quote(program))
}

/// A file as NTFS knows it: the volume's serial number and the file's
/// index on it. A renamed file keeps it; a file put in its place has another.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileId {
    pub volume: u32,
    pub index: u64,
}

/// True when the helper's program path (`now`) names another file than the
/// one it started from: a new version was put in its place, so the helper
/// exits and the agent's starter runs the new one. A path that cannot be
/// read (mid-switch) is not a replacement.
pub fn replaced(started: Option<FileId>, now: Option<FileId>) -> bool {
    matches!((started, now), (Some(started), Some(now)) if started != now)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: u32, state: i32, user: Option<&str>) -> SessionRecord {
        SessionRecord {
            id,
            state,
            user: user.map(str::to_string),
        }
    }

    fn session(id: u32, user: &str) -> TraySession {
        TraySession {
            id,
            user: user.into(),
        }
    }

    /// SPEC-TRAY-SESSIONS TS10.
    #[test]
    fn which_windows_sessions_get_a_helper() {
        const DISCONNECTED: i32 = 4;
        const LISTEN: i32 = 6;
        let records = [
            // Session 0 holds the services; it has no screen.
            record(0, WTS_ACTIVE, Some("SYSTEM")),
            record(1, WTS_ACTIVE, Some("jack")),
            // Remote Desktop, signed in.
            record(3, WTS_ACTIVE, Some(r"CORP\sam")),
            // A Remote Desktop client at the sign-in screen.
            record(4, WTS_CONNECTED, None),
            record(5, WTS_CONNECTED, Some("kim")),
            record(6, DISCONNECTED, Some("lee")),
            record(65536, LISTEN, None),
            record(7, WTS_ACTIVE, Some("  ")),
            // The same session twice: one helper.
            record(1, WTS_ACTIVE, Some("jack")),
        ];
        assert_eq!(
            tray_sessions(&records),
            [
                session(1, "jack"),
                session(3, r"CORP\sam"),
                session(5, "kim")
            ]
        );
        assert!(tray_sessions(&[]).is_empty());
    }

    /// SPEC-TRAY-SESSIONS TS11.
    #[test]
    fn the_helper_never_runs_elevated_or_as_a_service() {
        assert_eq!(token_use(ELEVATION_DEFAULT), Some(TokenUse::AsGiven));
        assert_eq!(token_use(ELEVATION_LIMITED), Some(TokenUse::AsGiven));
        assert_eq!(token_use(ELEVATION_FULL), Some(TokenUse::Linked));
        assert_eq!(token_use(0), None);
        assert_eq!(token_use(4), None);

        assert!(is_person_sid(
            "S-1-5-21-3623811015-3361044348-30300820-1013"
        ));
        assert!(is_person_sid(
            "S-1-12-1-1234567890-1234567890-1234567890-123456"
        ));
        for service in [
            "S-1-5-18",
            "S-1-5-19",
            "S-1-5-20",
            "S-1-5-32-544",
            "S-1-5-21-",
            "S-1-5-21-12-x",
            "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
            "",
        ] {
            assert!(!is_person_sid(service), "{service}");
        }
    }

    /// SPEC-TRAY-SESSIONS TS12.
    #[test]
    fn the_windows_helper_command_is_fixed() {
        assert_eq!(
            command_line(r"C:\Program Files\BMuster\bmuster-tray-0.4.20.exe"),
            r#""C:\Program Files\BMuster\bmuster-tray-0.4.20.exe" tray"#
        );
        assert_eq!(MUTEX_NAME, r"Local\BMusterTray");
    }

    /// SPEC-TRAY-SESSIONS TS13.
    #[test]
    fn the_windows_helper_sees_when_its_program_is_replaced() {
        let started = FileId {
            volume: 0x1234_5678,
            index: 42,
        };
        let renamed_or_same = started;
        let new_file = FileId {
            volume: 0x1234_5678,
            index: 43,
        };
        assert!(!replaced(Some(started), Some(renamed_or_same)));
        assert!(replaced(Some(started), Some(new_file)));
        assert!(
            !replaced(Some(started), None),
            "a path that cannot be read mid-switch is not a new version"
        );
        assert!(!replaced(None, Some(new_file)), "nothing to compare with");
    }

    /// SPEC-TRAY-SESSIONS TS15.
    #[test]
    fn the_icon_waits_for_the_taskbar() {
        // Start and a new taskbar always add, shown or not.
        for shown in [false, true] {
            assert_eq!(icon_call(shown, IconEvent::Start), IconCall::Add);
            assert_eq!(icon_call(shown, IconEvent::TaskbarCreated), IconCall::Add);
        }
        // Not shown (the taskbar was not ready): retry adds, tick waits.
        assert_eq!(icon_call(false, IconEvent::Retry), IconCall::Add);
        assert_eq!(icon_call(false, IconEvent::Tick), IconCall::Nothing);
        // Shown: tick keeps it current, a late retry does nothing.
        assert_eq!(icon_call(true, IconEvent::Tick), IconCall::Modify);
        assert_eq!(icon_call(true, IconEvent::Retry), IconCall::Nothing);
        assert_eq!(ICON_RETRY, Duration::from_secs(2));
    }

    /// SPEC-TRAY-SESSIONS TS16.
    #[test]
    fn each_version_has_its_own_tray_program() {
        let current = tray_file_name("0.4.20");
        assert_eq!(current, "bmuster-tray-0.4.20.exe");
        for other in [
            "bmuster-tray-0.4.19.exe",
            "BMuster-Tray-0.4.21.EXE",
            "bmuster-tray-0.4.20.exe.new",
            "bmuster-tray-0.4.20.exe.4321.old",
        ] {
            assert!(is_other_tray_file(other, &current), "{other}");
            assert!(is_tray_file(other), "{other}");
        }
        assert!(is_tray_file(&current));
        assert!(!is_tray_file("bmuster-agent.exe"));
        for kept in [
            "bmuster-tray-0.4.20.exe",
            "BMUSTER-TRAY-0.4.20.EXE",
            "bmuster-agent.exe",
            "bmuster-agent.old",
            "notes.txt",
        ] {
            assert!(!is_other_tray_file(kept, &current), "{kept}");
        }
    }

    /// SPEC-TRAY-SESSIONS TS17.
    #[test]
    fn older_trays_are_recognised() {
        let tray = r"C:\Program Files\BMuster\bmuster-tray-0.4.20.exe";
        let rescue = r"C:\Program Files\BMuster\bmuster-agent.exe";
        let kind = |image: &str, elevated| helper_kind(image, tray, rescue, elevated);
        assert_eq!(kind(tray, Some(false)), Helper::Current);
        assert_eq!(
            kind(r"c:\program files\bmuster\BMUSTER-TRAY-0.4.20.EXE", None),
            Helper::Current
        );
        assert_eq!(
            kind(
                r"C:\Program Files\BMuster\bmuster-tray-0.4.19.exe",
                Some(false)
            ),
            Helper::Stale
        );
        // The rescue copy: 0.4.19 and earlier ran the tray from it.
        assert_eq!(kind(rescue, Some(false)), Helper::Stale);
        assert_eq!(kind(&rescue.to_uppercase(), Some(false)), Helper::Stale);
        // An administrator's own elevated command, or unknown: left alone.
        assert_eq!(kind(rescue, Some(true)), Helper::Other);
        assert_eq!(kind(rescue, None), Helper::Other);
        // A tray-like name anywhere else, and other programs.
        for other in [
            r"C:\Users\kim\Downloads\bmuster-tray-0.4.20.exe",
            r"C:\Users\kim\bmuster-agent.exe",
            r"C:\ProgramData\BMuster\versions\current\bmuster-agent.exe",
            r"C:\Windows\explorer.exe",
            "bmuster-tray-0.4.19.exe",
            "",
        ] {
            assert_eq!(kind(other, Some(false)), Helper::Other, "{other}");
        }
    }

    /// SPEC-TRAY-SESSIONS TS19.
    #[test]
    fn the_old_sign_in_entry_is_known() {
        assert_eq!(RUN_KEY, r"Software\Microsoft\Windows\CurrentVersion\Run");
        assert_eq!(RUN_VALUE, "BMusterAgent");
    }
}
