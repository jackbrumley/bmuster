//! The console session: which one is active, who is signed in to it, which
//! processes run in it, and a message box on its screen. Written from the
//! Win32 Remote Desktop Services documentation.

use super::names::account_label;
use ::windows::core::{PCWSTR, PWSTR};
use ::windows::Win32::Foundation::{CloseHandle, HANDLE};
use ::windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use ::windows::Win32::System::RemoteDesktop::{
    ProcessIdToSessionId, WTSDomainName, WTSFreeMemory, WTSGetActiveConsoleSessionId,
    WTSQuerySessionInformationW, WTSSendMessageW, WTSUserName, WTS_INFO_CLASS,
};
use ::windows::Win32::System::Threading::GetCurrentProcessId;
use ::windows::Win32::UI::WindowsAndMessaging::{
    MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND, MB_TOPMOST, MESSAGEBOX_RESULT,
};

/// The session attached to the physical console, or
/// [`super::follow::NO_CONSOLE_SESSION`] mid-switch.
pub fn active_console_session() -> u32 {
    // SAFETY: no arguments; reads a kernel value.
    unsafe { WTSGetActiveConsoleSessionId() }
}

/// The session this process runs in.
pub fn current_session() -> Option<u32> {
    let mut session = 0u32;
    // SAFETY: `session` is a valid out-parameter.
    unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) }.ok()?;
    Some(session)
}

/// One string from `WTSQuerySessionInformationW`; empty when it fails.
fn session_string(session: u32, class: WTS_INFO_CLASS) -> String {
    let mut buffer = PWSTR::null();
    let mut bytes = 0u32;
    // SAFETY: WTS allocates `buffer`, a NUL-terminated string we free below.
    unsafe {
        if WTSQuerySessionInformationW(None, session, class, &mut buffer, &mut bytes).is_err()
            || buffer.is_null()
        {
            return String::new();
        }
        let text = buffer.to_string().unwrap_or_default();
        WTSFreeMemory(buffer.0.cast());
        text
    }
}

/// `session`'s connection state for the machine report (SPEC-DIAGNOSTICS
/// 4): `active`, `connected`, `disconnected`, … or `unknown`.
pub fn session_state(session: u32) -> String {
    use ::windows::Win32::System::RemoteDesktop::WTSConnectState;
    let mut buffer = PWSTR::null();
    let mut bytes = 0u32;
    // SAFETY: WTS allocates `buffer`, which holds one WTS_CONNECTSTATE_CLASS
    // (an i32) for this class; it is read once and freed below.
    let state = unsafe {
        if WTSQuerySessionInformationW(None, session, WTSConnectState, &mut buffer, &mut bytes)
            .is_err()
            || buffer.is_null()
            || (bytes as usize) < std::mem::size_of::<i32>()
        {
            return "unknown".into();
        }
        let state = buffer.0.cast::<i32>().read_unaligned();
        WTSFreeMemory(buffer.0.cast());
        state
    };
    match state {
        0 => "active",
        1 => "connected",
        2 => "connect-query",
        3 => "shadow",
        4 => "disconnected",
        5 => "idle",
        6 => "listen",
        7 => "reset",
        8 => "down",
        9 => "init",
        _ => "unknown",
    }
    .into()
}

/// Who is signed in to `session`: `jack`, or `CORP\jack` for a domain
/// account. `None` at the sign-in screen.
pub fn session_user(session: u32) -> Option<String> {
    let user = session_string(session, WTSUserName);
    let domain = session_string(session, WTSDomainName);
    let computer = std::env::var("COMPUTERNAME").unwrap_or_default();
    account_label(&user, &domain, &computer)
}

/// The user of the console session, for Overview's "Signed in".
pub fn console_user() -> Option<String> {
    let session = active_console_session();
    if session == super::follow::NO_CONSOLE_SESSION {
        return None;
    }
    session_user(session)
}

/// Closes a handle when dropped.
pub(crate) struct Owned(pub HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        // SAFETY: the handle is ours and closed once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// Process ids whose executable is `exe` (any case) in `session`.
pub fn processes_in_session(exe: &str, session: u32) -> Vec<u32> {
    session_processes(session, |name| name.eq_ignore_ascii_case(exe))
}

/// Process ids in `session` whose executable's file name `wanted` accepts.
pub fn session_processes(session: u32, wanted: impl Fn(&str) -> bool) -> Vec<u32> {
    // SAFETY: a process snapshot, walked with a correctly sized entry and
    // closed when `snapshot` drops.
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return Vec::new();
        };
        let snapshot = Owned(snapshot);
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = Vec::new();
        let mut more = Process32FirstW(snapshot.0, &mut entry).is_ok();
        while more {
            let name = crate::capture::windows::wide_to_string(&entry.szExeFile);
            let mut in_session = u32::MAX;
            if wanted(&name)
                && ProcessIdToSessionId(entry.th32ProcessID, &mut in_session).is_ok()
                && in_session == session
            {
                found.push(entry.th32ProcessID);
            }
            more = Process32NextW(snapshot.0, &mut entry).is_ok();
        }
        found
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Shows a message box with `title` and `text` on the console session's
/// screen, without waiting for anyone to close it. Works on every edition,
/// including Home, which has no `msg.exe`.
pub fn send_message(title: &str, text: &str) -> Result<(), String> {
    let session = active_console_session();
    if session == super::follow::NO_CONSOLE_SESSION {
        return Err("no session is attached to the console".into());
    }
    let title = wide(title);
    let text = wide(text);
    let mut response = MESSAGEBOX_RESULT(0);
    // SAFETY: both strings are NUL-terminated and outlive the call; the
    // lengths are in bytes without the NUL, as WTSSendMessageW wants.
    unsafe {
        WTSSendMessageW(
            None,
            session,
            PCWSTR(title.as_ptr()),
            ((title.len() - 1) * 2) as u32,
            PCWSTR(text.as_ptr()),
            ((text.len() - 1) * 2) as u32,
            MB_OK | MB_ICONINFORMATION | MB_TOPMOST | MB_SETFOREGROUND,
            0,
            &mut response,
            false,
        )
    }
    .map_err(|e| format!("WTSSendMessage to session {session}: {e}"))
}
