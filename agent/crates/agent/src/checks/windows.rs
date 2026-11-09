//! The Windows checks (SPEC-DIAGNOSTICS 1). The service checks its own
//! account, the console session and the Ctrl+Alt+Del policy; the capture
//! and input checks need the console session's desktop, so the service
//! starts the desktop helper there with `--check <file>`: it runs its fixed
//! checks, writes their results to the file and exits at once.
//!
//! Nothing is captured beyond one frame's size (dropped in the helper), and
//! `SendInput` is called with no events.

use super::{result, Check, Context, Outcome, CHECK_DEADLINE};
use anyhow::{Context as _, Result};
use bmuster_desktop::winsession::{command_line::quote, console, launch, sas_policy};
use bmuster_protocol::checks::{CheckResult, CheckStatus};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// The helper's checks, in the order it writes them.
const HELPER_CHECKS: [(&str, &str); 3] = [
    ("dxgi-duplication", "DXGI Desktop Duplication"),
    ("gdi-capture", "GDI capture"),
    ("send-input", "SendInput"),
];

/// The last helper run: its results, or why it gave none.
static HELPER: Mutex<Option<Result<Vec<CheckResult>, String>>> = Mutex::new(None);

pub fn checks() -> Vec<Check> {
    vec![
        Check {
            id: "service-account",
            title: "Runs as LocalSystem",
            run: service_account,
        },
        Check {
            id: "console-session",
            title: "Console session",
            run: console_session,
        },
        Check {
            id: "helper-launch",
            title: "Desktop helper starts in the console session",
            run: helper_launch,
        },
        Check {
            id: "dxgi-duplication",
            title: "DXGI Desktop Duplication",
            run: dxgi_duplication,
        },
        Check {
            id: "gdi-capture",
            title: "GDI capture",
            run: gdi_capture,
        },
        Check {
            id: "send-input",
            title: "SendInput",
            run: send_input,
        },
        Check {
            id: "sas-policy",
            title: "Ctrl+Alt+Del policy (SoftwareSASGeneration)",
            run: sas,
        },
        Check {
            id: "event-log",
            title: "Fixed Event Log query",
            run: event_log,
        },
    ]
}

fn service_account(_: &Context) -> Outcome {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::Security::{
        GetTokenInformation, IsWellKnownSid, TokenUser, WinLocalSystemSid, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    let mut token = std::ptr::null_mut();
    // SAFETY: the token handle is an out-parameter, closed below.
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Outcome::Fail(format!(
            "Could not open the agent's token: {}",
            std::io::Error::last_os_error()
        ));
    }
    let mut buffer = vec![0_u64; 64];
    let mut needed = 0_u32;
    // SAFETY: `buffer` is 512 bytes, aligned for TOKEN_USER; `needed` is an
    // out-parameter.
    let read = unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            buffer.as_mut_ptr().cast(),
            (buffer.len() * 8) as u32,
            &mut needed,
        )
    };
    let outcome = if read == 0 {
        Outcome::Fail(format!(
            "Could not read the agent's account: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        // SAFETY: GetTokenInformation filled the buffer with a TOKEN_USER.
        let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
        // SAFETY: the SID points into `buffer`, which is still alive.
        if unsafe { IsWellKnownSid(user.User.Sid, WinLocalSystemSid) } != 0 {
            Outcome::Pass("The service runs as LocalSystem.".into())
        } else {
            Outcome::Fail(
                "The service does not run as LocalSystem, so it cannot start the desktop helper."
                    .into(),
            )
        }
    };
    // SAFETY: the handle came from OpenProcessToken.
    unsafe { CloseHandle(token) };
    outcome
}

fn console_session(_: &Context) -> Outcome {
    let session = console::active_console_session();
    if session == bmuster_desktop::winsession::follow::NO_CONSOLE_SESSION {
        return Outcome::Fail("No session is attached to the console right now.".into());
    }
    Outcome::Pass(format!(
        "Session {session} ({}), {}.",
        console::session_state(session),
        console::session_user(session).unwrap_or_else(|| "nobody signed in".to_string())
    ))
}

/// Starts `desktop-helper --check <file>` in the console session and reads
/// what it wrote.
fn run_helper(context: &Context) -> Result<Vec<CheckResult>, String> {
    let session = console::active_console_session();
    if session == bmuster_desktop::winsession::follow::NO_CONSOLE_SESSION || session == 0 {
        return Err("No console session to start the helper in.".into());
    }
    let program =
        std::env::current_exe().map_err(|e| format!("Cannot find this program's path: {e}"))?;
    let dir = context.data_dir.join("checks");
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let out = dir.join(format!("helper-{}.json", std::process::id()));
    let _ = std::fs::remove_file(&out);
    let line = format!(
        "{} desktop-helper --check {} --data-dir {}",
        quote(&program.to_string_lossy()),
        quote(&out.to_string_lossy()),
        quote(&context.data_dir.to_string_lossy()),
    );
    let job = launch::Job::new()?;
    let process = launch::start_in_session(session, &line, &job)?;
    let wait = CHECK_DEADLINE.saturating_sub(Duration::from_secs(2));
    if !process.wait(wait) {
        process.kill();
        let _ = std::fs::remove_file(&out);
        return Err(format!(
            "The helper did not finish its checks in {} s.",
            wait.as_secs()
        ));
    }
    let code = process.exit_code();
    let bytes = std::fs::read(&out);
    let _ = std::fs::remove_file(&out);
    match (code, bytes) {
        (Some(0), Ok(bytes)) => Ok(results_from_helper(&bytes)),
        (code, _) => Err(format!(
            "The helper exited with code {code:?} without its results; desktop-helper.log says why."
        )),
    }
}

/// The helper's file as results: one for each of [`HELPER_CHECKS`], in
/// order; one it left out or garbled is a failure saying so. Only the
/// helper's own ids are taken.
pub fn results_from_helper(bytes: &[u8]) -> Vec<CheckResult> {
    let written: Vec<CheckResult> = serde_json::from_slice(bytes).unwrap_or_default();
    HELPER_CHECKS
        .iter()
        .map(|(id, title)| {
            written
                .iter()
                .find(|result| result.id == *id)
                .cloned()
                .map(|mut found| {
                    found.title = (*title).to_string();
                    found
                })
                .unwrap_or_else(|| CheckResult {
                    id: (*id).to_string(),
                    title: (*title).to_string(),
                    status: CheckStatus::Fail,
                    detail: "The desktop helper did not report this check.".into(),
                    duration_ms: 0,
                    checked_at: crate::logging::now_ms(),
                })
        })
        .collect()
}

fn helper_launch(context: &Context) -> Outcome {
    let ran = run_helper(context);
    let outcome = match &ran {
        Ok(_) => Outcome::Pass("The helper started in the console session and exited 0.".into()),
        Err(reason) => Outcome::Fail(reason.clone()),
    };
    *HELPER.lock().unwrap_or_else(|p| p.into_inner()) = Some(ran);
    outcome
}

/// One of the helper's results, from the run `helper-launch` just made.
fn from_helper(id: &str) -> Outcome {
    match &*HELPER.lock().unwrap_or_else(|p| p.into_inner()) {
        None => Outcome::Fail("The desktop helper was not started.".into()),
        Some(Err(reason)) => Outcome::Fail(format!("The desktop helper gave no results: {reason}")),
        Some(Ok(results)) => match results.iter().find(|result| result.id == id) {
            Some(found) => match found.status {
                CheckStatus::Pass => Outcome::Pass(found.detail.clone()),
                CheckStatus::Fail => Outcome::Fail(found.detail.clone()),
                CheckStatus::NotApplicable => Outcome::NotApplicable(found.detail.clone()),
            },
            None => Outcome::Fail("The desktop helper did not report this check.".into()),
        },
    }
}

fn dxgi_duplication(_: &Context) -> Outcome {
    from_helper("dxgi-duplication")
}

fn gdi_capture(_: &Context) -> Outcome {
    from_helper("gdi-capture")
}

fn send_input(_: &Context) -> Outcome {
    from_helper("send-input")
}

/// `SoftwareSASGeneration`, if set.
pub fn sas_value() -> Option<u32> {
    windows_registry::LOCAL_MACHINE
        .open(sas_policy::POLICY_KEY)
        .ok()?
        .get_u32(sas_policy::POLICY_VALUE)
        .ok()
}

fn sas(_: &Context) -> Outcome {
    let value = sas_value();
    let shown = value.map_or_else(|| "not set".to_string(), |v| v.to_string());
    if sas_policy::allows_services(value) {
        Outcome::Pass(format!(
            "{} is {shown}: the agent can send Ctrl+Alt+Del.",
            sas_policy::POLICY_VALUE
        ))
    } else {
        Outcome::Fail(format!(
            "{} is {shown}: services cannot send Ctrl+Alt+Del (the agent sets it on the first Ctrl+Alt+Del).",
            sas_policy::POLICY_VALUE
        ))
    }
}

fn event_log(_: &Context) -> Outcome {
    let [(log, xpath), _] = crate::diagnostics::windows::event_log_queries();
    match crate::diagnostics::windows::query(log, &xpath, 1) {
        Ok(events) => Outcome::Pass(format!(
            "The fixed query answered ({} recent entr{} naming BMuster).",
            events.len(),
            if events.len() == 1 { "y" } else { "ies" }
        )),
        Err(reason) => Outcome::Fail(reason),
    }
}

/// `desktop-helper --check <out>`: the helper's fixed checks in this
/// console session, written to `out` as JSON.
pub fn helper_checks(out: &Path) -> Result<()> {
    bmuster_desktop::winsession::prepare_helper_process();
    let started = Instant::now();
    let checked_at = crate::logging::now_ms();
    let (dxgi, gdi) = bmuster_desktop::capture::windows::check_capture();
    let input = bmuster_desktop::input::windows::check_send_input();
    let elapsed = started.elapsed();
    let results: Vec<CheckResult> = HELPER_CHECKS
        .iter()
        .zip([dxgi, gdi, input])
        .map(|((id, title), outcome)| {
            let check = Check {
                id,
                title,
                run: |_| Outcome::Fail(String::new()),
            };
            let outcome = match outcome {
                Ok(detail) => Outcome::Pass(detail),
                Err(detail) => Outcome::Fail(detail),
            };
            result(&check, outcome, elapsed, checked_at)
        })
        .collect();
    crate::identity::write_private(out, &serde_json::to_vec(&results)?)
        .with_context(|| format!("could not write {}", out.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SPEC-DIAGNOSTICS D4 (compiled on Windows).
    #[test]
    fn results_from_helper() {
        let written = serde_json::json!([
            { "id": "gdi-capture", "title": "x", "status": "pass", "detail": "One frame of \\\\.\\DISPLAY1 1920x1080.", "durationMs": 40, "checkedAt": 5 },
            { "id": "dxgi-duplication", "title": "x", "status": "fail", "detail": "DXGI_ERROR_UNSUPPORTED", "durationMs": 3, "checkedAt": 5 },
            { "id": "something-else", "title": "x", "status": "pass", "detail": "", "durationMs": 0, "checkedAt": 5 }
        ]);
        let results = super::results_from_helper(&serde_json::to_vec(&written).unwrap());
        let shown: Vec<(&str, CheckStatus)> =
            results.iter().map(|r| (r.id.as_str(), r.status)).collect();
        assert_eq!(
            shown,
            [
                ("dxgi-duplication", CheckStatus::Fail),
                ("gdi-capture", CheckStatus::Pass),
                ("send-input", CheckStatus::Fail),
            ]
        );
        assert_eq!(results[1].title, "GDI capture");
        assert!(results[2].detail.contains("did not report"));
        assert!(super::results_from_helper(b"not json")
            .iter()
            .all(|r| r.status == CheckStatus::Fail));
    }
}
