//! `bmuster-agent clipboard-helper <socket>`: the person's end of a KMS
//! screen's clipboard (SPEC-DESKTOP 21.10). Runs as them, in a transient
//! unit the agent starts; holds no agent files, keys or credentials. It
//! answers the agent's clipboard commands through the first route the
//! desktop offers ([`super::routes`]) until the agent closes the socket,
//! which ends it and with it any text it was still offering.

use super::data_control::DataControl;
use super::routes::{Backend, Backends};
use super::xwayland::{self, XWayland};
use crate::wayland::wire::{self, Command, Event, Packet};
use anyhow::{bail, Context as _, Result};
use std::collections::HashMap;
use std::io::{BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Command as Process, Stdio};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// How long the user manager may take to list its environment.
const ENVIRONMENT_WAIT: Duration = Duration::from_secs(2);

pub fn run(socket: &Path) -> Result<()> {
    // SAFETY: geteuid cannot fail.
    if unsafe { libc::geteuid() } == 0 {
        bail!("The clipboard helper must run as the signed-in user");
    }
    let stream = UnixStream::connect(socket)
        .with_context(|| format!("could not connect to {}", socket.display()))?;
    let runtime = std::env::var_os("XDG_RUNTIME_DIR")
        .context("The signed-in user's runtime directory is unavailable")?;
    let runtime = Path::new(&runtime);
    let environment = match session_environment() {
        Ok(environment) => environment,
        Err(error) => {
            log::warn!("The session's environment is unavailable: {error:#}");
            HashMap::new()
        }
    };
    // wl-clipboard-rs connects to WAYLAND_DISPLAY; set before any thread.
    let wayland = environment
        .get("WAYLAND_DISPLAY")
        .filter(|display| !display.is_empty())
        .cloned()
        .map_or_else(|| crate::wayland::helper::find_wayland_display(runtime), Ok);
    match wayland {
        Ok(display) => std::env::set_var("WAYLAND_DISPLAY", display),
        Err(error) => log::info!("No Wayland display for the clipboard: {error:#}"),
    }
    let target = xwayland::target(&environment, &xwayland::xauthority_files(runtime));
    let mut backends = Backends::new(vec![
        Box::new(DataControl) as Box<dyn Backend>,
        Box::new(XWayland::new(target.clone())),
    ]);
    let input = BufReader::new(stream.try_clone()?);
    let output = Arc::new(Mutex::new(stream));
    let telling = Arc::clone(&output);
    std::thread::Builder::new()
        .name("clipboard watch".into())
        .spawn(move || {
            super::watch::watch(target, || {
                let mut output = telling.lock().unwrap_or_else(PoisonError::into_inner);
                wire::json(&mut *output, &Event::ClipboardChanged).is_ok()
            })
        })?;
    serve(input, &output, &mut backends)
}

/// The person's systemd user manager's environment, where desktops put
/// `WAYLAND_DISPLAY`, `DISPLAY` and `XAUTHORITY`.
fn session_environment() -> Result<HashMap<String, String>> {
    let mut child = Process::new("systemctl")
        .args(["--user", "--no-pager", "show-environment"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("could not run systemctl")?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if started.elapsed() > ENVIRONMENT_WAIT {
            let _ = child.kill();
            let _ = child.wait();
            bail!("systemctl --user did not answer");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    let mut text = String::new();
    if let Some(mut output) = child.stdout.take() {
        output.read_to_string(&mut text)?;
    }
    if !status.success() {
        bail!("systemctl --user show-environment exited with {status}");
    }
    Ok(xwayland::parse_environment(&text))
}

/// The agent's clipboard commands, one at a time, until it closes the
/// socket or says `Stop`. Each answer carries the command's id; the route
/// that served it is named first whenever it changes. Never the text in
/// a log.
pub(crate) fn serve(
    mut input: impl Read,
    output: &Mutex<impl Write>,
    backends: &mut Backends,
) -> Result<()> {
    loop {
        let command = match wire::read(&mut input) {
            Ok(Packet::Json(bytes)) if bytes.len() <= wire::MAX_JSON => {
                serde_json::from_slice::<Command>(&bytes)?
            }
            Ok(_) => bail!("Invalid clipboard command packet"),
            // The agent closed the socket: the session has ended.
            Err(_) => return Ok(()),
        };
        let answer = match command {
            Command::ClipboardSet { id, text } => match backends.set(&text) {
                Ok(()) => Event::ClipboardSet { id },
                Err(message) => Event::ClipboardFailed { id, message },
            },
            Command::ClipboardGet { id } => match backends.get() {
                Ok(text) => Event::ClipboardText { id, text },
                Err(message) => Event::ClipboardFailed { id, message },
            },
            Command::Stop => return Ok(()),
            _ => bail!("The clipboard helper takes only clipboard commands"),
        };
        let mut output = output.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(backend) = backends.changed() {
            wire::json(
                &mut *output,
                &Event::ClipboardBackend {
                    backend: backend.to_string(),
                },
            )?;
        }
        wire::json(&mut *output, &answer)?;
    }
}
