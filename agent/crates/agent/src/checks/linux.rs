//! The Linux checks (SPEC-DIAGNOSTICS 1). The unit checks run exactly the
//! sessions' and helpers' code paths with a harmless program in place of
//! the real one, so a failure names the step that breaks a real session:
//!
//! - `systemd-run`: [`TransientUnit`] as terminal sessions make it, no pty.
//! - `systemd-run-pipe`: the console helper's unit (`--pipe`), with `/bin/cat`.
//! - `terminal-pty`: [`Pty::spawn`] on a fresh pty, as the terminal does.
//!
//! Every unit is `--collect`ed and stopped when the check ends; the uinput
//! device has no capabilities and is destroyed at once; the KMS check's
//! pixels never leave the helper.

use super::{Check, Context, Outcome, CHECK_DEADLINE};
use crate::console_helper::{unit_arguments_running, HelperClient};
use crate::diagnostics::Journal;
use crate::exec::placement::{Kind, Placement};
use crate::exec::pty::{Pty, Spawned};
use crate::exec::spawn::{Launch, Program};
use crate::exec::unit::{Io, TransientUnit};
use crate::exec::PtySize;
use bmuster_desktop::capture::kms::KmsSource as _;
use bmuster_desktop::capture::x11_follow::{active_session, look_at, session_properties};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// The most of a command's output a check keeps.
const MAX_OUTPUT: u64 = 16 * 1024;
/// A check's own waits end a little before the runner's deadline, so it
/// cleans up and says why itself.
const WAIT: Duration = Duration::from_millis(CHECK_DEADLINE.as_millis() as u64 - 1500);
const LINE: &[u8] = b"bmuster self-check\n";

pub fn checks() -> Vec<Check> {
    vec![
        Check {
            id: "systemd-run",
            title: "Transient unit (as terminal sessions start)",
            run: systemd_run,
        },
        Check {
            id: "systemd-run-pipe",
            title: "Transient unit with --pipe (as the helpers start)",
            run: systemd_run_pipe,
        },
        Check {
            id: "terminal-pty",
            title: "Terminal unit on a pty",
            run: terminal_pty,
        },
        Check {
            id: "logind-seat",
            title: "Screen session (logind seat0)",
            run: logind_seat,
        },
        Check {
            id: "kms-capture",
            title: "Console capture helper (KMS)",
            run: kms_capture,
        },
        Check {
            id: "egl",
            title: "EGL, GLES and GBM on each render node",
            run: egl,
        },
        Check {
            id: "uinput",
            title: "Virtual input device (uinput)",
            run: uinput,
        },
        Check {
            id: "x11-display",
            title: "X11 display",
            run: x11_display,
        },
        Check {
            id: "portal",
            title: "Desktop portal on the user's session bus",
            run: portal,
        },
        Check {
            id: "journal",
            title: "Fixed journal query",
            run: journal,
        },
        Check {
            id: "audit",
            title: "Audit denials (last 15 minutes)",
            run: audit,
        },
    ]
}

fn systemd_present() -> bool {
    Path::new("/run/systemd/system").is_dir()
}

fn is_root() -> bool {
    // SAFETY: geteuid has no arguments and cannot fail.
    unsafe { libc::geteuid() == 0 }
}

/// A unit name part no session uses: `check-<8 hex>`.
fn check_id() -> String {
    let mut bytes = [0_u8; 4];
    let _ = getrandom::getrandom(&mut bytes);
    format!("check-{}", hex::encode(bytes))
}

/// `/bin/true` (or `/bin/cat`) with no environment, in `/`.
fn harmless(program: &str) -> Launch {
    Launch {
        program: Program {
            path: PathBuf::from(program),
            arg0: Path::new(program)
                .file_name()
                .map(OsString::from)
                .unwrap_or_default(),
            args: Vec::new(),
        },
        env: Vec::new(),
        cwd: PathBuf::from("/"),
    }
}

/// Reads up to [`MAX_OUTPUT`] of `reader` on a thread.
fn collect(reader: impl Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
    let (send, received) = mpsc::channel();
    let _ = std::thread::Builder::new()
        .name("check output".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            let _ = reader.take(MAX_OUTPUT).read_to_end(&mut bytes);
            let _ = send.send(bytes);
        });
    received
}

fn text(received: &mpsc::Receiver<Vec<u8>>) -> String {
    received
        .recv_timeout(Duration::from_millis(500))
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .unwrap_or_default()
}

/// Waits for `child` until `until`; kills it after.
fn wait_until(child: &mut Child, until: Instant) -> Option<ExitStatus> {
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Some(status),
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

/// The helpers' units belong to the system manager.
fn stop_unit(unit: &str) {
    let _ = Command::new("systemctl")
        .args(["stop", "--no-block", unit])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn systemd_run(context: &Context) -> Outcome {
    let Some(manager) = context.mode.manager() else {
        return Outcome::NotApplicable(
            "Sessions run inside the agent's own process (BMUSTER_SESSIONS is not systemd).".into(),
        );
    };
    let unit = match TransientUnit::new(manager, Kind::Terminal, &check_id()) {
        Ok(unit) => unit,
        Err(error) => return Outcome::Fail(format!("{error:#}")),
    };
    let mut command = unit.command(Io::Detached, &harmless("/bin/true"));
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return Outcome::Fail(format!("Could not run systemd-run: {error}")),
    };
    let stderr = child.stderr.take().map(collect);
    let status = wait_until(&mut child, Instant::now() + WAIT);
    unit.stop();
    let errors = stderr.as_ref().map(text).unwrap_or_default();
    match status {
        Some(status) if status.success() => {
            Outcome::Pass(format!("{} ran /bin/true and exited 0.", unit.name()))
        }
        Some(status) => Outcome::Fail(format!(
            "systemd-run for {} exited with {status}: {errors}",
            unit.name()
        )),
        None => Outcome::Fail(format!(
            "systemd-run for {} did not finish in {} s: {errors}",
            unit.name(),
            WAIT.as_secs()
        )),
    }
}

fn systemd_run_pipe(context: &Context) -> Outcome {
    if !systemd_present() {
        return Outcome::NotApplicable("This machine does not run systemd.".into());
    }
    if !is_root() {
        return Outcome::NotApplicable(
            "The agent is not running as root (a development run); the helpers need root.".into(),
        );
    }
    let unit = format!("bmuster-console-{}", check_id());
    let mut child = match Command::new("systemd-run")
        .args(unit_arguments_running(
            &unit,
            Path::new("/bin/cat"),
            &[],
            &context.data_dir,
        ))
        .current_dir("/")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => return Outcome::Fail(format!("Could not run systemd-run: {error}")),
    };
    let stderr = child.stderr.take().map(collect);
    let (send, echoed) = mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = std::thread::Builder::new()
            .name("check pipe".into())
            .spawn(move || {
                let mut bytes = vec![0_u8; LINE.len()];
                let read = stdout.read_exact(&mut bytes).map(|()| bytes);
                let _ = send.send(read.map_err(|error| error.to_string()));
            });
    }
    let written = child
        .stdin
        .as_mut()
        .map(|stdin| stdin.write_all(LINE).and_then(|()| stdin.flush()));
    let answer = echoed.recv_timeout(WAIT - Duration::from_secs(2));
    // End of input ends cat, and with it the unit.
    drop(child.stdin.take());
    let status = wait_until(&mut child, Instant::now() + Duration::from_secs(2));
    stop_unit(&unit);
    let errors = stderr.as_ref().map(text).unwrap_or_default();
    let status = status.map_or_else(|| "still running".to_string(), |s| s.to_string());
    match (written, answer) {
        (Some(Ok(())), Ok(Ok(bytes))) if bytes == LINE => Outcome::Pass(format!(
            "{unit}.service echoed a line through its pipes ({status})."
        )),
        (Some(Err(error)), _) => Outcome::Fail(format!(
            "Could not write to {unit}.service's pipe: {error}. systemd-run ({status}) said: {errors}"
        )),
        (_, Ok(Ok(bytes))) => Outcome::Fail(format!(
            "{unit}.service sent back {:?} instead of the line. systemd-run ({status}) said: {errors}",
            String::from_utf8_lossy(&bytes)
        )),
        (_, Ok(Err(error))) => Outcome::Fail(format!(
            "Reading {unit}.service's pipe failed: {error}. systemd-run ({status}) said: {errors}"
        )),
        (_, Err(_)) => Outcome::Fail(format!(
            "{unit}.service did not echo the line in time. systemd-run ({status}) said: {errors}"
        )),
    }
}

fn terminal_pty(context: &Context) -> Outcome {
    let Some(manager) = context.mode.manager() else {
        return Outcome::NotApplicable(
            "Sessions run inside the agent's own process (BMUSTER_SESSIONS is not systemd).".into(),
        );
    };
    let unit = match TransientUnit::new(manager, Kind::Terminal, &check_id()) {
        Ok(unit) => unit,
        Err(error) => return Outcome::Fail(format!("{error:#}")),
    };
    let name = unit.name().to_string();
    let Spawned {
        pty,
        mut process,
        reader,
        writer,
    } = match Pty::spawn(
        &harmless("/bin/true"),
        Placement::Unit(unit),
        PtySize::clamped(80, 24),
    ) {
        Ok(spawned) => spawned,
        Err(error) => return Outcome::Fail(format!("Could not start {name}: {error:#}")),
    };
    drop(writer);
    let output = collect(reader);
    let (send, exited) = mpsc::channel();
    let _ = std::thread::Builder::new()
        .name("check pty".into())
        .spawn(move || {
            let _ = send.send(process.wait().map_err(|error| format!("{error:#}")));
        });
    let code = exited.recv_timeout(WAIT);
    // Ends the unit and systemd-run's session; the terminal then hangs up.
    pty.end();
    drop(pty);
    let shown = text(&output);
    let shown = if shown.is_empty() {
        "nothing".to_string()
    } else {
        format!("{shown:?}")
    };
    match code {
        Ok(Ok(0)) => Outcome::Pass(format!("{name} ran /bin/true on a pty and exited 0.")),
        Ok(Ok(code)) => Outcome::Fail(format!(
            "{name} exited with {code}{}; the terminal showed {shown}.",
            if code == 208 {
                " (208: systemd could not set up the unit's standard input on the pty)"
            } else {
                ""
            }
        )),
        Ok(Err(error)) => Outcome::Fail(format!("Could not wait for {name}: {error}")),
        Err(_) => Outcome::Fail(format!(
            "{name} did not finish in {} s; the terminal showed {shown}.",
            WAIT.as_secs()
        )),
    }
}

/// seat0's active session and its properties, `None` when there is none.
/// A logind session id and its properties.
type SeatSession = (String, HashMap<String, String>);

fn seat_session() -> Result<Option<SeatSession>, String> {
    let active = active_session()?;
    let session = active.trim();
    if session.is_empty() {
        return Ok(None);
    }
    session_properties(session).map(|properties| Some((session.to_string(), properties)))
}

fn property<'a>(properties: &'a HashMap<String, String>, key: &str) -> &'a str {
    properties.get(key).map_or("", String::as_str)
}

fn logind_seat(_: &Context) -> Outcome {
    if !Path::new("/run/systemd/seats").is_dir() {
        return Outcome::NotApplicable("This machine has no logind seats.".into());
    }
    match seat_session() {
        Ok(None) => Outcome::Pass("seat0 has no active session (nothing on the screen).".into()),
        Ok(Some((session, properties))) => Outcome::Pass(format!(
            "Session {session}: type {}, class {}, state {}, user {}.",
            property(&properties, "Type"),
            property(&properties, "Class"),
            property(&properties, "State"),
            property(&properties, "Name"),
        )),
        Err(error) => Outcome::Fail(error),
    }
}

fn kms_capture(context: &Context) -> Outcome {
    if !systemd_present() {
        return Outcome::NotApplicable("This machine does not run systemd.".into());
    }
    if !is_root() {
        return Outcome::NotApplicable(
            "The agent is not running as root (a development run); the helper needs root.".into(),
        );
    }
    let program = match crate::wayland::helper_program() {
        Ok(program) => program,
        Err(error) => return Outcome::Fail(format!("{error:#}")),
    };
    let mut client = match HelperClient::start(&program, &context.data_dir) {
        Ok(client) => client,
        Err(error) => return Outcome::Fail(format!("{error:#}")),
    };
    let displays = match client.displays() {
        Ok(displays) => displays,
        Err(error) => return Outcome::Fail(error.0),
    };
    if displays.is_empty() {
        return Outcome::Pass("The helper started; no display is lit (the screen is off).".into());
    }
    let mut found = Vec::new();
    for display in &displays {
        match client.frame_size(&display.id) {
            Ok((width, height)) => found.push(format!("{} {width}x{height}", display.name)),
            Err(error) => return Outcome::Fail(format!("{}: {}", display.name, error.0)),
        }
    }
    Outcome::Pass(format!("Captured one frame of {}.", found.join(", ")))
}

fn render_nodes() -> Vec<PathBuf> {
    let mut nodes: Vec<PathBuf> = std::fs::read_dir("/dev/dri")
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("renderD"))
        })
        .collect();
    nodes.sort();
    nodes
}

fn egl(_: &Context) -> Outcome {
    let nodes = render_nodes();
    if nodes.is_empty() {
        return Outcome::NotApplicable("No render nodes in /dev/dri.".into());
    }
    let mut lines = Vec::new();
    let mut failed = false;
    for node in &nodes {
        match bmuster_desktop::capture::kms::egl::Gpu::open(node) {
            Ok(gpu) => {
                drop(gpu);
                lines.push(format!("{}: context created", node.display()));
            }
            Err(error) => {
                failed = true;
                lines.push(format!("{}: {error}", node.display()));
            }
        }
    }
    if failed {
        Outcome::Fail(lines.join("; "))
    } else {
        Outcome::Pass(lines.join("; "))
    }
}

fn uinput(_: &Context) -> Outcome {
    let path = Path::new(bmuster_desktop::input::uinput::UINPUT);
    if !path.exists() {
        return Outcome::Fail(format!(
            "{} is missing: the uinput module is not loaded, so the console cannot be controlled.",
            path.display()
        ));
    }
    match bmuster_desktop::input::uinput::check_device(path) {
        Ok(()) => Outcome::Pass(format!(
            "Created and destroyed \"{}\", a device with no keys or buttons.",
            bmuster_desktop::input::uinput::CHECK_NAME
        )),
        Err(error) => Outcome::Fail(format!("{}: {error}", path.display())),
    }
}

fn x11_display(_: &Context) -> Outcome {
    let (session, properties) = match seat_session() {
        Ok(Some(found)) => found,
        Ok(None) => return Outcome::NotApplicable("seat0 has no active session.".into()),
        Err(error) => return Outcome::NotApplicable(format!("No logind seat: {error}")),
    };
    if property(&properties, "Type") != "x11" {
        return Outcome::NotApplicable(format!(
            "The screen shows a {} session, not X11.",
            property(&properties, "Type")
        ));
    }
    let (_, Some(seen)) = look_at(&session, &properties) else {
        return Outcome::Fail("The X11 session on the screen has no display.".into());
    };
    let xauthority = bmuster_desktop::capture::x11_session::find_xauthority(
        &session,
        &seen.display,
        &seen.user,
        &seen.uid,
    );
    let target = bmuster_desktop::capture::x11_session::X11Target {
        display: seen.display.clone(),
        xauthority: xauthority.clone(),
    };
    match bmuster_desktop::capture::x11_session::root_size(&target) {
        Ok((width, height)) => Outcome::Pass(format!(
            "Connected to {} ({}): {width}x{height}.",
            seen.display,
            xauthority.map_or_else(
                || "no Xauthority".to_string(),
                |path| path.display().to_string()
            ),
        )),
        Err(error) => Outcome::Fail(format!("{}: {error}", seen.display)),
    }
}

const PORTAL_NAME: &str = "org.freedesktop.portal.Desktop";

/// `busctl` on `uid`'s session bus, as that user.
fn bus_names(uid: u32, method: &str) -> Result<String, String> {
    use std::os::unix::fs::MetadataExt as _;
    use std::os::unix::process::CommandExt as _;
    let runtime = format!("/run/user/{uid}");
    let gid = std::fs::metadata(&runtime)
        .map_err(|error| format!("{runtime}: {error}"))?
        .gid();
    let mut child = Command::new("/usr/bin/busctl")
        .args([
            "--user",
            "--no-pager",
            "call",
            "org.freedesktop.DBus",
            "/org/freedesktop/DBus",
            "org.freedesktop.DBus",
            method,
        ])
        .env_clear()
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={runtime}/bus"),
        )
        .env("XDG_RUNTIME_DIR", &runtime)
        .uid(uid)
        .gid(gid)
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not run busctl: {error}"))?;
    let stdout = child.stdout.take().map(collect);
    let stderr = child.stderr.take().map(collect);
    let status = wait_until(&mut child, Instant::now() + Duration::from_secs(3));
    let out = stdout.as_ref().map(text).unwrap_or_default();
    match status {
        Some(status) if status.success() => Ok(out),
        Some(status) => Err(format!(
            "busctl {method} exited with {status}: {}",
            stderr.as_ref().map(text).unwrap_or_default()
        )),
        None => Err(format!("busctl {method} did not answer in 3 s")),
    }
}

fn portal(_: &Context) -> Outcome {
    let (_, properties) = match seat_session() {
        Ok(Some(found)) => found,
        Ok(None) => return Outcome::NotApplicable("seat0 has no active session.".into()),
        Err(error) => return Outcome::NotApplicable(format!("No logind seat: {error}")),
    };
    if property(&properties, "Type") != "wayland" || property(&properties, "Class") != "user" {
        return Outcome::NotApplicable(format!(
            "The screen shows a {} {} session, not a Wayland desktop.",
            property(&properties, "Type"),
            property(&properties, "Class")
        ));
    }
    let Ok(uid) = property(&properties, "User").parse::<u32>() else {
        return Outcome::Fail("logind names no user for the Wayland session.".into());
    };
    let quoted = format!("\"{PORTAL_NAME}\"");
    match bus_names(uid, "ListNames") {
        Ok(names) if names.contains(&quoted) => {
            return Outcome::Pass(format!("{PORTAL_NAME} is running on user {uid}'s bus."))
        }
        Ok(_) => {}
        Err(error) => return Outcome::Fail(error),
    }
    match bus_names(uid, "ListActivatableNames") {
        Ok(names) if names.contains(&quoted) => Outcome::Pass(format!(
            "{PORTAL_NAME} is not running but starts on demand on user {uid}'s bus."
        )),
        Ok(_) => Outcome::Fail(format!(
            "{PORTAL_NAME} is neither running nor activatable on user {uid}'s bus: install xdg-desktop-portal."
        )),
        Err(error) => Outcome::Fail(error),
    }
}

fn journal(_: &Context) -> Outcome {
    match crate::diagnostics::journal_probe() {
        Journal::Available { lines, .. } => Outcome::Pass(format!(
            "The fixed query answered with {} line{}.",
            lines.len(),
            if lines.len() == 1 { "" } else { "s" }
        )),
        Journal::Unavailable { reason } => Outcome::Fail(reason),
    }
}

fn audit(_: &Context) -> Outcome {
    match crate::diagnostics::denials() {
        Journal::Available { lines, .. } if lines.is_empty() => {
            Outcome::Pass("No denials in the last 15 minutes.".into())
        }
        Journal::Available { lines, .. } => {
            let newest: Vec<&str> = lines.iter().rev().take(3).map(String::as_str).collect();
            Outcome::Pass(format!(
                "{} denial{} in the last 15 minutes; newest: {}",
                lines.len(),
                if lines.len() == 1 { "" } else { "s" },
                newest.join(" | ")
            ))
        }
        Journal::Unavailable { reason } => Outcome::Fail(reason),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::console_helper::{serve, Reply};
    use crate::wayland::wire::{self, Packet};
    use bmuster_desktop::capture::kms::{KmsCursor, KmsDisplay};
    use bmuster_desktop::capture::{CaptureResult, CursorImage, Frame};
    use bmuster_desktop::input::uinput::{CheckRequest, CAPABILITY_REQUESTS, CHECK_REQUESTS};

    /// The spec's list, in order; the unit checks clean up after themselves.
    pub fn the_list_is_fixed_and_leaves_nothing_behind() {
        let ids: Vec<&str> = checks().iter().map(|check| check.id).collect();
        assert_eq!(
            ids,
            [
                "systemd-run",
                "systemd-run-pipe",
                "terminal-pty",
                "logind-seat",
                "kms-capture",
                "egl",
                "uinput",
                "x11-display",
                "portal",
                "journal",
                "audit"
            ]
        );
        // Sessions in the agent's own process: the unit checks do not apply.
        let context = Context {
            data_dir: std::env::temp_dir(),
            mode: crate::exec::placement::SessionMode::InProcess,
        };
        assert!(matches!(systemd_run(&context), Outcome::NotApplicable(_)));
        assert!(matches!(terminal_pty(&context), Outcome::NotApplicable(_)));
        if !is_root() {
            assert!(matches!(
                systemd_run_pipe(&context),
                Outcome::NotApplicable(_)
            ));
            assert!(matches!(kms_capture(&context), Outcome::NotApplicable(_)));
        }
        // The units are collected when they end and their names are the
        // check's own, which the agent's sweep also stops.
        let unit = TransientUnit::new(
            crate::exec::unit::Manager::System,
            Kind::Terminal,
            &check_id(),
        )
        .unwrap();
        let arguments: Vec<String> = unit
            .arguments(Io::Detached, &harmless("/bin/true"))
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(arguments.contains(&"--collect".to_string()));
        assert!(unit.name().starts_with("bmuster-terminal-check-"));
        let pipe: Vec<String> = unit_arguments_running(
            "bmuster-console-check-1",
            Path::new("/bin/cat"),
            &[],
            Path::new("/var/lib/bmuster"),
        )
        .iter()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
        assert!(pipe.contains(&"--pipe".to_string()));
        assert!(pipe.contains(&"--collect".to_string()));
        assert_eq!(pipe.last().map(String::as_str), Some("/bin/cat"));
        let helper = crate::console_helper::unit_arguments(
            "bmuster-console-check-1",
            Path::new("/opt/bmuster-agent"),
            Path::new("/var/lib/bmuster"),
        );
        let helper: Vec<String> = helper
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            helper[..helper.len() - 2],
            pipe[..pipe.len() - 1],
            "the same unit as the console helper, but for its program"
        );
    }

    struct OneScreen;

    impl bmuster_desktop::capture::kms::KmsSource for OneScreen {
        fn displays(&mut self) -> CaptureResult<Vec<KmsDisplay>> {
            Ok(Vec::new())
        }
        fn capture(&mut self, _id: &str, _full: bool) -> CaptureResult<Option<Frame>> {
            Ok(Some(Frame::new(64, 32)))
        }
        fn cursor(&mut self, _id: &str) -> CaptureResult<KmsCursor> {
            Ok(KmsCursor::HIDDEN)
        }
        fn cursor_image(&mut self, _shape: u32) -> CaptureResult<Option<CursorImage>> {
            Ok(None)
        }
    }

    pub fn the_uinput_device_has_no_capabilities_and_kms_sends_no_pixels() {
        assert_eq!(
            CHECK_REQUESTS,
            [
                CheckRequest::Setup,
                CheckRequest::Create,
                CheckRequest::Destroy
            ]
        );
        assert!(CHECK_REQUESTS
            .iter()
            .all(|request| !CAPABILITY_REQUESTS.contains(&request.number())));

        let mut input = Vec::new();
        wire::json(
            &mut input,
            &crate::console_helper::Request::FrameSize {
                display: "card1-eDP-1".into(),
            },
        )
        .unwrap();
        let mut output = Vec::new();
        serve(input.as_slice(), &mut output, &mut OneScreen).unwrap();
        let mut reader = output.as_slice();
        let Packet::Json(bytes) = wire::read(&mut reader).unwrap() else {
            panic!("the answer is JSON");
        };
        assert!(matches!(
            serde_json::from_slice::<Reply>(&bytes).unwrap(),
            Reply::Size {
                width: 64,
                height: 32
            }
        ));
        assert!(reader.is_empty(), "no pixel packet follows the size");
    }
}
