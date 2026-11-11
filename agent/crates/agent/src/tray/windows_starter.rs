//! Starts the tray helper in every signed-in Windows session
//! (SPEC-TRAY-SESSIONS, Windows).
//!
//! The service runs as LocalSystem in session 0. Every [`POLL`] its worker
//! lists the sessions ([`super::windows_sessions::tray_sessions`]: active or
//! connected, someone signed in, never session 0). A session whose helper is
//! not running gets one through the shared [`Starter`]: started as the
//! session's own person, with the token `WTSQueryUserToken` gives (its
//! filtered half when it is elevated, never SYSTEM), their own environment
//! and the `winsta0\default` desktop.
//!
//! The only program ever started is the installed program in Program Files
//! (the copy the sign-in `Run` entry starts, which every user may read; the
//! running version in ProgramData is readable by SYSTEM and Administrators
//! only) with the one argument `tray`. Nothing from the server or the session
//! changes it.

use super::starts::{Desktop, Starter};
use super::windows_sessions::{self as rules, SessionRecord, TokenUse, TraySession};
use bmuster_desktop::winsession::console::{processes_in_session, session_user};
use std::ffi::{c_void, OsStr};
use std::os::windows::ffi::OsStrExt as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HANDLE, LUID};
use windows::Win32::Security::{
    AdjustTokenPrivileges, DuplicateTokenEx, GetTokenInformation, LookupPrivilegeValueW,
    SecurityImpersonation, TokenElevationType, TokenLinkedToken, TokenPrimary, TokenSessionId,
    TokenUser, LUID_AND_ATTRIBUTES, SE_DEBUG_NAME, SE_PRIVILEGE_ENABLED, TOKEN_ADJUST_DEFAULT,
    TOKEN_ADJUST_PRIVILEGES, TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
    TOKEN_ELEVATION_TYPE, TOKEN_LINKED_TOKEN, TOKEN_PRIVILEGES, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
use windows::Win32::System::RemoteDesktop::{
    WTSEnumerateSessionsW, WTSFreeMemory, WTSQueryUserToken, WTS_SESSION_INFOW,
};
use windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
    QueryFullProcessImageNameW, TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW,
    CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE, STARTUPINFOW,
};

/// How often the sessions are listed.
pub const POLL: Duration = Duration::from_secs(10);
/// How long the uninstall waits for each helper it ends.
const EXIT_WAIT_MS: u32 = 5000;

/// Closes a handle when dropped.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: the handle is ours and closed once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(Some(0)).collect()
}

/// Every session on the machine, whatever its state.
fn sessions() -> Vec<SessionRecord> {
    let mut list: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
    let mut count = 0u32;
    // SAFETY: WTS allocates `count` entries at `list`, read here and freed
    // once below.
    unsafe {
        if WTSEnumerateSessionsW(None, 0, 1, &mut list, &mut count).is_err() || list.is_null() {
            return Vec::new();
        }
        let records = std::slice::from_raw_parts(list, count as usize)
            .iter()
            .map(|info| SessionRecord {
                id: info.SessionId,
                state: info.State.0,
                user: session_user(info.SessionId),
            })
            .collect();
        WTSFreeMemory(list.cast());
        records
    }
}

/// The full path of process `pid`'s program, when it can be read.
fn image_path(process: HANDLE) -> Option<PathBuf> {
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    // SAFETY: `buffer` holds `length` characters; Windows writes the path
    // and its length without the NUL.
    unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut length,
        )
        .ok()?;
    }
    buffer.truncate(length as usize);
    Some(PathBuf::from(String::from_utf16_lossy(&buffer)))
}

/// The ids of the processes in `session` whose program is `program`
/// (other than this one).
fn helpers(program: &Path, session: u32) -> Vec<u32> {
    let Some(name) = program.file_name().and_then(OsStr::to_str) else {
        return Vec::new();
    };
    let wanted = program.to_string_lossy();
    // SAFETY: no arguments.
    let own = unsafe { GetCurrentProcessId() };
    processes_in_session(name, session)
        .into_iter()
        .filter(|pid| *pid != own)
        .filter_map(|pid| {
            // SAFETY: opens a process by id; the handle is owned at once.
            let process =
                Owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?);
            let path = image_path(process.0)?;
            path.to_string_lossy()
                .eq_ignore_ascii_case(&wanted)
                .then_some(pid)
        })
        .collect()
}

/// The token's `TOKEN_INFORMATION_CLASS` value of a fixed size.
///
/// # Safety
/// `T` must be the plain structure Windows writes for `class`.
unsafe fn token_value<T: Default>(
    token: HANDLE,
    class: windows::Win32::Security::TOKEN_INFORMATION_CLASS,
) -> Result<T, String> {
    let mut value = T::default();
    let mut length = 0u32;
    // SAFETY: `value` is a `T` of the stated size, as the caller promises
    // Windows writes for `class`.
    unsafe {
        GetTokenInformation(
            token,
            class,
            Some((&mut value as *mut T).cast::<c_void>()),
            std::mem::size_of::<T>() as u32,
            &mut length,
        )
    }
    .map_err(|e| format!("GetTokenInformation({}): {e}", class.0))?;
    Ok(value)
}

/// The token's user as a SID string (`S-1-5-21-…`).
fn token_user(token: HANDLE) -> Result<String, String> {
    let mut length = 0u32;
    // SAFETY: the first call only reports the size; the second writes a
    // TOKEN_USER (and the SID it points to) into a buffer of that size,
    // aligned for it.
    unsafe {
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut length);
        let mut buffer = vec![0u64; (length as usize).div_ceil(8)];
        GetTokenInformation(
            token,
            TokenUser,
            Some(buffer.as_mut_ptr().cast()),
            length,
            &mut length,
        )
        .map_err(|e| format!("GetTokenInformation(TokenUser): {e}"))?;
        let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
        super::windows::sid_text(user.User.Sid).map_err(|e| format!("{e:#}"))
    }
}

/// A primary token for `session`'s person: the session's own token, or
/// its filtered half when it is elevated. Refuses anything that is not a
/// person's unelevated token in that session.
fn person_token(session: u32) -> Result<Owned, String> {
    let mut given = HANDLE::default();
    // SAFETY: an out-parameter; the token is owned at once.
    unsafe { WTSQueryUserToken(session, &mut given) }
        .map_err(|e| format!("WTSQueryUserToken: {e}"))?;
    let mut token = Owned(given);
    for _ in 0..2 {
        // SAFETY: TOKEN_ELEVATION_TYPE is what TokenElevationType writes.
        let elevation: TOKEN_ELEVATION_TYPE = unsafe { token_value(token.0, TokenElevationType)? };
        match rules::token_use(elevation.0) {
            None => return Err(format!("unknown token elevation type {}", elevation.0)),
            Some(TokenUse::AsGiven) => {
                let user = token_user(token.0)?;
                if !rules::is_person_sid(&user) {
                    return Err(format!(
                        "the session's token belongs to {user}, not a person"
                    ));
                }
                // SAFETY: a u32 is what TokenSessionId writes.
                let in_session: u32 = unsafe { token_value(token.0, TokenSessionId)? };
                if in_session != session {
                    return Err(format!("the token is for session {in_session}"));
                }
                return Ok(token);
            }
            Some(TokenUse::Linked) => {
                // SAFETY: TOKEN_LINKED_TOKEN is what TokenLinkedToken writes;
                // the linked token is owned at once and duplicated as a
                // primary token, owned too.
                unsafe {
                    let linked: TOKEN_LINKED_TOKEN = token_value(token.0, TokenLinkedToken)?;
                    let linked = Owned(linked.LinkedToken);
                    let mut primary = HANDLE::default();
                    DuplicateTokenEx(
                        linked.0,
                        TOKEN_ASSIGN_PRIMARY
                            | TOKEN_DUPLICATE
                            | TOKEN_QUERY
                            | TOKEN_ADJUST_DEFAULT
                            | TOKEN_ADJUST_SESSIONID,
                        None,
                        SecurityImpersonation,
                        TokenPrimary,
                        &mut primary,
                    )
                    .map_err(|e| format!("DuplicateTokenEx(linked token): {e}"))?;
                    token = Owned(primary);
                }
            }
        }
    }
    Err("the session's token stays elevated".into())
}

/// The person's environment block, destroyed when dropped.
struct Environment(*mut c_void);

impl Drop for Environment {
    fn drop(&mut self) {
        // SAFETY: made by CreateEnvironmentBlock and destroyed once.
        unsafe {
            let _ = DestroyEnvironmentBlock(self.0);
        }
    }
}

/// Starts `program tray` in `session` as its person.
fn start_helper(program: &Path, session: u32) -> Result<(), String> {
    let token = person_token(session)?;
    let mut block: *mut c_void = std::ptr::null_mut();
    // SAFETY: an out-parameter, owned at once.
    unsafe { CreateEnvironmentBlock(&mut block, Some(token.0), false) }
        .map_err(|e| format!("CreateEnvironmentBlock: {e}"))?;
    let environment = Environment(block);
    let application = wide(program.as_os_str());
    let mut line: Vec<u16> = rules::command_line(&program.to_string_lossy())
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let folder = wide(program.parent().unwrap_or(program).as_os_str());
    let mut desktop = wide(OsStr::new("winsta0\\default"));
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        lpDesktop: PWSTR(desktop.as_mut_ptr()),
        ..Default::default()
    };
    let mut info = PROCESS_INFORMATION::default();
    // SAFETY: every buffer outlives the call; the command line is mutable as
    // CreateProcessAsUserW requires; no handles are inherited; the new
    // process and thread handles are closed at once.
    unsafe {
        CreateProcessAsUserW(
            Some(token.0),
            PCWSTR(application.as_ptr()),
            Some(PWSTR(line.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            Some(environment.0.cast_const()),
            PCWSTR(folder.as_ptr()),
            &startup,
            &mut info,
        )
        .map_err(|e| format!("CreateProcessAsUserW: {e}"))?;
        drop(Owned(info.hThread));
        drop(Owned(info.hProcess));
    }
    Ok(())
}

/// The machine itself: its sessions, their processes and their tokens.
struct System {
    program: PathBuf,
}

impl Desktop for System {
    type Who = TraySession;

    fn signed_in(&mut self) -> Vec<TraySession> {
        rules::tray_sessions(&sessions())
    }

    fn running(&mut self, session: &TraySession) -> bool {
        !helpers(&self.program, session.id).is_empty()
    }

    fn start(&mut self, session: &TraySession) -> Result<(), String> {
        start_helper(&self.program, session.id)
    }
}

/// From the worker's start: on the installed, launched agent, starts the
/// helper in each signed-in session until `stop`.
pub fn start(data_dir: &Path, launched: bool, stop: Arc<AtomicBool>) {
    let installed = crate::paths::default_data_dir().is_ok_and(|dir| dir == data_dir);
    if !launched || !installed {
        return;
    }
    let program = match crate::service_windows::binary_path() {
        Ok(program) if program.is_file() => program,
        Ok(program) => {
            log::warn!(
                "No tray in signed-in sessions: {} is missing.",
                program.display()
            );
            return;
        }
        Err(error) => {
            log::warn!("No tray in signed-in sessions: {error:#}");
            return;
        }
    };
    let started = std::thread::Builder::new()
        .name("tray sessions".into())
        .spawn(move || {
            let mut starter = Starter::default();
            let mut system = System { program };
            while !stop.load(Ordering::SeqCst) {
                for attempt in starter.tick(&mut system, Instant::now()) {
                    let who = format!("session {} ({})", attempt.who.id, attempt.who.user);
                    match attempt.result {
                        Ok(()) => log::info!("Started the tray in {who}."),
                        Err(reason) if attempt.new_reason => {
                            log::warn!("Could not start the tray in {who}: {reason}");
                        }
                        Err(reason) => {
                            log::debug!("Still cannot start the tray in {who}: {reason}");
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

/// Lets this process open other people's processes: an administrator's
/// uninstall ends tray helpers that run as someone else. SYSTEM may already.
fn enable_debug_privilege() -> Result<(), String> {
    // SAFETY: our own process token, owned at once; one privilege of the
    // stated count.
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
            &mut token,
        )
        .map_err(|e| format!("OpenProcessToken: {e}"))?;
        let token = Owned(token);
        let mut luid = LUID::default();
        LookupPrivilegeValueW(PCWSTR::null(), SE_DEBUG_NAME, &mut luid)
            .map_err(|e| format!("LookupPrivilegeValueW: {e}"))?;
        let privileges = TOKEN_PRIVILEGES {
            PrivilegeCount: 1,
            Privileges: [LUID_AND_ATTRIBUTES {
                Luid: luid,
                Attributes: SE_PRIVILEGE_ENABLED,
            }],
        };
        AdjustTokenPrivileges(token.0, false, Some(&privileges), 0, None, None)
            .map_err(|e| format!("AdjustTokenPrivileges: {e}"))
    }
}

/// Uninstall: ends every tray helper running `program`, in every session,
/// so its folder can be removed. Returns how many it ended.
pub fn stop_helpers(program: &Path) -> usize {
    if let Err(reason) = enable_debug_privilege() {
        log::debug!("Ending tray helpers without the debug privilege: {reason}");
    }
    let mut ended = 0;
    for session in sessions() {
        for pid in helpers(program, session.id) {
            // SAFETY: opens the helper to end it and wait for it; the handle
            // is owned at once.
            let result = unsafe {
                OpenProcess(PROCESS_TERMINATE | PROCESS_SYNCHRONIZE, false, pid).and_then(
                    |process| {
                        let process = Owned(process);
                        TerminateProcess(process.0, 0)?;
                        WaitForSingleObject(process.0, EXIT_WAIT_MS);
                        Ok(())
                    },
                )
            };
            match result {
                Ok(()) => ended += 1,
                Err(error) => log::warn!("Could not end the tray helper {pid}: {error}"),
            }
        }
    }
    ended
}
