//! The KMS console helper (SPEC-CONSOLE-CAPTURE, Capture 1): the physical
//! screen is read by `bmuster-agent console-helper`, a transient root unit
//! with access to `/dev/dri` only, no network and no view of the agent's
//! data folder. It answers the agent's requests over its inherited stdin
//! and stdout with the helper wire format, and ends when the pipe closes.
//! Nothing secret crosses the pipe: requests name a display, replies carry
//! pixels.
//!
//! - [`run`]: the helper's side, a [`KmsReader`] behind [`serve`].
//! - [`HelperClient`]: the agent's side, a [`KmsSource`] over the pipe.
//! - [`Opener`]: starts one helper per desktop session that needs KMS.
//! - [`probe`]: `bmuster-agent kms-probe`, the same reader in-process, for
//!   a person checking a machine by hand.

mod probe;

pub use probe::probe;

use crate::wayland::wire::{self, Packet};
use anyhow::{bail, Context as _, Result};
use bmuster_desktop::capture::kms::capturer::SharedSource;
use bmuster_desktop::capture::kms::device::KmsReader;
use bmuster_desktop::capture::kms::{KmsCursor, KmsDisplay, KmsSource};
use bmuster_desktop::capture::x11_follow::ConsoleOpener;
use bmuster_desktop::capture::{CaptureError, CaptureResult, CursorImage, Frame};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The largest side of a frame either end accepts.
const MAX_SIDE: u32 = 16384;
/// A request is a few names; anything longer is not ours.
const MAX_REQUEST: usize = 4096;
/// How long the agent waits for the helper's first answer (it opens every
/// card) and for each one after.
const FIRST_ANSWER: Duration = Duration::from_secs(10);
const ANSWER: Duration = Duration::from_secs(3);

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Request {
    Displays,
    Capture { display: String, full: bool },
    Cursor { display: String },
    CursorImage { shape: u32 },
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Reply {
    Displays {
        list: Vec<KmsDisplay>,
    },
    /// BGRX rows follow as one raw packet.
    Frame {
        width: u32,
        height: u32,
    },
    Unchanged,
    Cursor {
        cursor: KmsCursor,
    },
    /// Straight-alpha RGBA rows follow as one raw packet.
    CursorImage {
        width: u32,
        height: u32,
    },
    NoCursorImage,
    Failed {
        message: String,
    },
}

/// A source that only says why there is none (the helper could not open
/// any card), so the agent hears the reason instead of a closed pipe.
struct Unavailable(String);

impl KmsSource for Unavailable {
    fn displays(&mut self) -> CaptureResult<Vec<KmsDisplay>> {
        Err(CaptureError::new(self.0.clone()))
    }
    fn capture(&mut self, _id: &str, _full: bool) -> CaptureResult<Option<Frame>> {
        Err(CaptureError::new(self.0.clone()))
    }
    fn cursor(&mut self, _id: &str) -> CaptureResult<KmsCursor> {
        Err(CaptureError::new(self.0.clone()))
    }
    fn cursor_image(&mut self, _shape: u32) -> CaptureResult<Option<CursorImage>> {
        Ok(None)
    }
}

/// The helper process: serve the machine's screens until the agent closes
/// the pipe.
pub fn run() -> Result<()> {
    let mut source: Box<dyn KmsSource> = match KmsReader::open() {
        Ok(reader) => Box::new(reader),
        Err(error) => {
            log::warn!("Console capture is unavailable: {error}");
            Box::new(Unavailable(error.0))
        }
    };
    serve(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        &mut *source,
    )
}

fn packed(width: u32, height: u32, stride: usize, data: &[u8]) -> Vec<u8> {
    let row = width as usize * 4;
    if stride == row {
        return data[..row * height as usize].to_vec();
    }
    let mut bytes = Vec::with_capacity(row * height as usize);
    for y in 0..height as usize {
        bytes.extend_from_slice(&data[y * stride..y * stride + row]);
    }
    bytes
}

/// Answers requests from `input` on `output` until `input` ends.
pub fn serve(
    mut input: impl Read,
    mut output: impl Write,
    source: &mut dyn KmsSource,
) -> Result<()> {
    loop {
        let packet = match wire::read(&mut input) {
            Ok(packet) => packet,
            Err(error) => {
                let closed = error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::UnexpectedEof);
                if closed {
                    return Ok(());
                }
                return Err(error);
            }
        };
        let Packet::Json(bytes) = packet else {
            bail!("The agent sent the console helper something other than a request");
        };
        if bytes.len() > MAX_REQUEST {
            bail!("The agent sent the console helper an oversized request");
        }
        let request: Request = serde_json::from_slice(&bytes)?;
        let failed = |error: CaptureError| Reply::Failed { message: error.0 };
        match request {
            Request::Displays => {
                let reply = match source.displays() {
                    Ok(list) => Reply::Displays { list },
                    Err(error) => failed(error),
                };
                wire::json(&mut output, &reply)?;
            }
            Request::Capture { display, full } => match source.capture(&display, full) {
                Ok(Some(frame)) => {
                    wire::json(
                        &mut output,
                        &Reply::Frame {
                            width: frame.width,
                            height: frame.height,
                        },
                    )?;
                    let bytes = packed(frame.width, frame.height, frame.stride, &frame.data);
                    wire::write(&mut output, &Packet::Raw(bytes))?;
                }
                Ok(None) => wire::json(&mut output, &Reply::Unchanged)?,
                Err(error) => wire::json(&mut output, &failed(error))?,
            },
            Request::Cursor { display } => {
                let reply = match source.cursor(&display) {
                    Ok(cursor) => Reply::Cursor { cursor },
                    Err(error) => failed(error),
                };
                wire::json(&mut output, &reply)?;
            }
            Request::CursorImage { shape } => match source.cursor_image(shape) {
                Ok(Some(image)) if !image.rgba.is_empty() => {
                    wire::json(
                        &mut output,
                        &Reply::CursorImage {
                            width: image.width,
                            height: image.height,
                        },
                    )?;
                    wire::write(&mut output, &Packet::Raw(image.rgba))?;
                }
                Ok(_) => wire::json(&mut output, &Reply::NoCursorImage)?,
                Err(error) => wire::json(&mut output, &failed(error))?,
            },
        }
    }
}

/// `systemd-run`'s arguments for the helper unit `unit`. The unit runs as
/// root (reading a framebuffer needs `CAP_SYS_ADMIN`, its only capability),
/// may open the DRM devices and the standard pseudo-devices only, has no
/// network, cannot see `data_dir` (the agent's identity and tokens) and is
/// otherwise as strict as the agent's own unit. `MemoryDenyWriteExecute`
/// stays off because GPU drivers compile shaders at run time.
pub fn unit_arguments(unit: &str, program: &Path, data_dir: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "--quiet",
        "--pipe",
        "--wait",
        "--collect",
        "--service-type=exec",
    ]
    .map(OsString::from)
    .to_vec();
    args.push(format!("--unit={unit}").into());
    let mut properties: Vec<OsString> = [
        "KillMode=control-group",
        "TimeoutStopSec=3",
        "UMask=0077",
        "NoNewPrivileges=yes",
        "CapabilityBoundingSet=CAP_SYS_ADMIN",
        "DevicePolicy=closed",
        "DeviceAllow=char-drm rw",
        "PrivateNetwork=yes",
        "IPAddressDeny=any",
        "RestrictAddressFamilies=AF_UNIX",
        "ProtectSystem=strict",
        "ProtectHome=yes",
        "PrivateTmp=yes",
        "ProtectKernelTunables=yes",
        "ProtectKernelModules=yes",
        "ProtectKernelLogs=yes",
        "ProtectControlGroups=yes",
        "ProtectClock=yes",
        "ProtectHostname=yes",
        "RestrictSUIDSGID=yes",
        "RestrictRealtime=yes",
        "RestrictNamespaces=yes",
        "LockPersonality=yes",
        "SystemCallArchitectures=native",
        "MemoryDenyWriteExecute=no",
    ]
    .map(OsString::from)
    .to_vec();
    // `-`: a data folder that does not exist yet is not an error.
    let mut hidden = OsString::from("InaccessiblePaths=-");
    hidden.push(data_dir);
    properties.push(hidden);
    for property in properties {
        args.push("-p".into());
        args.push(property);
    }
    // The shader cache would live in root's home, which the unit cannot see.
    args.push("--setenv=MESA_SHADER_CACHE_DISABLE=true".into());
    args.push("--".into());
    args.push(program.into());
    args.push("console-helper".into());
    args
}

/// The agent's side of one helper.
pub struct HelperClient {
    input: Box<dyn Write + Send>,
    replies: Receiver<Result<Packet, String>>,
    /// Ends the helper on drop (the unit, or a test's thread).
    _guard: Box<dyn Send>,
    answered: bool,
    broken: Option<String>,
}

/// Stops the helper unit when the client goes.
struct UnitGuard {
    child: Child,
    unit: String,
}

impl Drop for UnitGuard {
    fn drop(&mut self) {
        let _ = std::process::Command::new("systemctl")
            .args(["stop", "--no-block", &self.unit])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl HelperClient {
    /// Starts `program console-helper` as a transient root unit.
    pub fn start(program: &Path, data_dir: &Path) -> Result<HelperClient> {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let unit = format!(
            "bmuster-console-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        );
        let mut child = std::process::Command::new("systemd-run")
            .args(unit_arguments(&unit, program, data_dir))
            .current_dir("/")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .context("Could not start the console capture helper")?;
        // systemd-run's own errors and the helper's (SPEC-AGENT-LOGS 1).
        crate::diagnostics::ship_helper_stderr("console-helper", child.stderr.take());
        let (Some(input), Some(output)) = (child.stdin.take(), child.stdout.take()) else {
            let _ = child.kill();
            let _ = child.wait();
            bail!("The console capture helper has no pipe");
        };
        log::info!("Started the console capture helper {unit}");
        Ok(HelperClient::over(
            Box::new(input),
            Box::new(output),
            Box::new(UnitGuard { child, unit }),
        ))
    }

    /// A client over any pipe pair; `guard` is dropped with the client.
    pub fn over(
        input: Box<dyn Write + Send>,
        mut output: Box<dyn Read + Send>,
        guard: Box<dyn Send>,
    ) -> HelperClient {
        let (send, replies) = mpsc::sync_channel(2);
        let reader = std::thread::Builder::new()
            .name("console helper".into())
            .spawn(move || loop {
                let packet = wire::read(&mut output).map_err(|e| format!("{e:#}"));
                let stop = packet.is_err();
                if send.send(packet).is_err() || stop {
                    return;
                }
            });
        let broken = reader
            .err()
            .map(|e| format!("Could not start reading the console helper: {e}"));
        HelperClient {
            input,
            replies,
            _guard: guard,
            answered: false,
            broken,
        }
    }

    fn fail(&mut self, message: String) -> CaptureError {
        if self.broken.is_none() {
            log::warn!("{message}");
            // It never answered: it failed to start, so ship the journal.
            if !self.answered {
                crate::diagnostics::session_failed("desktop");
            }
        }
        self.broken = Some(message.clone());
        CaptureError::new(message)
    }

    fn next(&mut self) -> CaptureResult<Packet> {
        let wait = if self.answered { ANSWER } else { FIRST_ANSWER };
        match self.replies.recv_timeout(wait) {
            Ok(Ok(packet)) => {
                self.answered = true;
                Ok(packet)
            }
            Ok(Err(error)) => {
                Err(self.fail(format!("The console capture helper stopped: {error}")))
            }
            Err(RecvTimeoutError::Timeout) => {
                Err(self.fail("The console capture helper stopped answering".to_string()))
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err(self.fail("The console capture helper ended".to_string()))
            }
        }
    }

    fn ask(&mut self, request: &Request) -> CaptureResult<Reply> {
        if let Some(reason) = &self.broken {
            return Err(CaptureError::new(reason.clone()));
        }
        if let Err(error) = wire::json(&mut self.input, request) {
            return Err(self.fail(format!("The console capture helper ended: {error:#}")));
        }
        match self.next()? {
            Packet::Json(bytes) if bytes.len() <= wire::MAX_PACKET => {
                match serde_json::from_slice::<Reply>(&bytes) {
                    Ok(Reply::Failed { message }) => Err(CaptureError::new(message)),
                    Ok(reply) => Ok(reply),
                    Err(error) => {
                        Err(self.fail(format!("The console capture helper sent nonsense: {error}")))
                    }
                }
            }
            _ => Err(self.fail("The console capture helper sent pixels out of turn".to_string())),
        }
    }

    /// The raw packet after a `frame` or `cursor-image` reply, checked
    /// against the size it announced.
    fn pixels(&mut self, width: u32, height: u32) -> CaptureResult<Vec<u8>> {
        if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE {
            return Err(self.fail(format!(
                "The console capture helper sent a {width}x{height} image"
            )));
        }
        match self.next()? {
            Packet::Raw(bytes) if bytes.len() == width as usize * height as usize * 4 => Ok(bytes),
            _ => {
                Err(self
                    .fail("The console capture helper sent the wrong number of pixels".to_string()))
            }
        }
    }
}

impl KmsSource for HelperClient {
    fn displays(&mut self) -> CaptureResult<Vec<KmsDisplay>> {
        match self.ask(&Request::Displays)? {
            Reply::Displays { list } => Ok(list),
            other => Err(self.fail(format!("Unexpected console helper reply {other:?}"))),
        }
    }

    fn capture(&mut self, id: &str, full: bool) -> CaptureResult<Option<Frame>> {
        let request = Request::Capture {
            display: id.to_string(),
            full,
        };
        match self.ask(&request)? {
            Reply::Frame { width, height } => {
                let data = self.pixels(width, height)?;
                Ok(Some(Frame {
                    width,
                    height,
                    stride: width as usize * 4,
                    data,
                }))
            }
            Reply::Unchanged => Ok(None),
            other => Err(self.fail(format!("Unexpected console helper reply {other:?}"))),
        }
    }

    fn cursor(&mut self, id: &str) -> CaptureResult<KmsCursor> {
        match self.ask(&Request::Cursor {
            display: id.to_string(),
        })? {
            Reply::Cursor { cursor } => Ok(cursor),
            other => Err(self.fail(format!("Unexpected console helper reply {other:?}"))),
        }
    }

    fn cursor_image(&mut self, shape: u32) -> CaptureResult<Option<CursorImage>> {
        match self.ask(&Request::CursorImage { shape })? {
            Reply::CursorImage { width, height } => Ok(Some(CursorImage {
                width,
                height,
                hotspot_x: 0,
                hotspot_y: 0,
                rgba: self.pixels(width, height)?,
            })),
            Reply::NoCursorImage => Ok(None),
            other => Err(self.fail(format!("Unexpected console helper reply {other:?}"))),
        }
    }
}

/// Starts a helper for a desktop session's watch.
pub struct Opener {
    data_dir: PathBuf,
}

impl Opener {
    pub fn new(data_dir: &Path) -> Opener {
        Opener {
            data_dir: data_dir.to_path_buf(),
        }
    }
}

impl ConsoleOpener for Opener {
    fn open(&mut self) -> Result<SharedSource, String> {
        let program = crate::wayland::helper_program().map_err(|e| format!("{e:#}"))?;
        let client = HelperClient::start(&program, &self.data_dir).map_err(|e| format!("{e:#}"))?;
        Ok(Arc::new(Mutex::new(Box::new(client))))
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
