//! The Windows tray starter's decisions (SPEC-TRAY-SESSIONS, Windows): which
//! sessions get a helper, which token it runs with, its fixed command line,
//! and when a running helper bows out for a new program. Pure, so the tests
//! run on every build machine; the Win32 calls are in `windows_starter.rs`
//! and `windows.rs`.

use bmuster_desktop::winsession::command_line::quote;

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
            command_line(r"C:\Program Files\BMuster\bmuster-agent.exe"),
            r#""C:\Program Files\BMuster\bmuster-agent.exe" tray"#
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
}
