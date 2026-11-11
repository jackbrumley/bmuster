//! Files sessions in a transient unit (SPEC-SESSION-UNITS).
//!
//! File actions in the agent's process would meet its sandbox (read-only
//! /home and system folders). With `--sessions systemd` the agent starts
//! `bmuster-agent files-helper` as the session's own service and relays the
//! session socket's messages to it unchanged; the helper runs the same
//! request code ([`super::files::Requests`]), so every path check happens in
//! the helper, never in the relay.
//!
//! Between the two, each message is a frame on the helper's stdin or
//! stdout: one byte for the kind (0 text, 1 binary), the payload's length
//! as four bytes big-endian, then the payload. The helper runs under
//! `stdio-host` (Version 2), which carries its stdin, stdout and stderr
//! over the connect-back socket, so nothing of the agent's passes through
//! systemd.

use super::files::{Requests, OUTPUT_QUEUE};
use super::pump::{pump, Ended, Incoming, Outgoing};
use crate::exec::host::{self, HostProgram, InputWriter, Started};
use crate::exec::spawn::{Launch, Program};
use crate::exec::unit::TransientUnit;
use crate::socket::Socket;
use anyhow::{Context as _, Result};
use bmuster_protocol::session::SessionEvent;
use std::ffi::OsString;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::Arc;
use std::time::Duration;

const TEXT: u8 = 0;
const BINARY: u8 = 1;
/// The largest frame either side accepts: a chunk is at most 8 MB and a
/// listing at most 5,000 entries, so anything bigger is a broken stream.
const MAX_FRAME: usize = 64 * 1024 * 1024;
/// How long the helper gets to finish after its input closes.
const EXIT_WAIT: Duration = Duration::from_secs(2);

fn write_frame(output: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    let length = u32::try_from(payload.len())
        .ok()
        .filter(|&length| length as usize <= MAX_FRAME)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;
    output.write_all(&[kind])?;
    output.write_all(&length.to_be_bytes())?;
    output.write_all(payload)?;
    output.flush()
}

fn write_message(output: &mut impl Write, message: &Outgoing) -> io::Result<()> {
    match message {
        Outgoing::Text(text) => write_frame(output, TEXT, text.as_bytes()),
        Outgoing::Bytes(bytes) => write_frame(output, BINARY, bytes),
        Outgoing::Done(event) => write_frame(output, TEXT, &serde_json::to_vec(event)?),
    }
}

/// The next frame, or `None` when the stream ended between frames.
fn read_frame(input: &mut impl Read) -> io::Result<Option<Incoming>> {
    let mut kind = [0u8; 1];
    match input.read_exact(&mut kind) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let mut length = [0u8; 4];
    input.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("a frame of {length} bytes is too large"),
        ));
    }
    let mut payload = vec![0u8; length];
    input.read_exact(&mut payload)?;
    match kind[0] {
        TEXT => String::from_utf8(payload)
            .map(|text| Some(Incoming::Text(text)))
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
        BINARY => Ok(Some(Incoming::Bytes(payload))),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unknown frame kind {other}"),
        )),
    }
}

fn write_all(output: impl Write, outgoing: &Receiver<Outgoing>) {
    let mut output = BufWriter::new(output);
    for message in outgoing {
        if let Err(e) = write_message(&mut output, &message) {
            log::debug!("The files helper's output closed: {e}");
            return;
        }
    }
}

/// `bmuster-agent files-helper`: serves one files session's requests from
/// `input` until it closes, replying on `output`.
pub fn serve(
    input: impl Read,
    output: impl Write + Send + 'static,
    data_dir: PathBuf,
) -> Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    let (sender, outgoing) = mpsc::sync_channel::<Outgoing>(OUTPUT_QUEUE);
    let writer = std::thread::Builder::new()
        .name("files-output".into())
        .spawn(move || write_all(output, &outgoing))
        .context("could not start the output thread")?;
    let mut requests = Requests::new(sender, Arc::clone(&stop), data_dir);
    let mut input = BufReader::new(input);
    let read = loop {
        match read_frame(&mut input) {
            Ok(Some(message)) => requests.take(message),
            Ok(None) => break Ok(()),
            Err(e) => break Err(e),
        }
    };
    stop.store(true, Ordering::SeqCst);
    requests.finish();
    // Requests still running reply (or fail to) and drop the last senders.
    if writer.join().is_err() {
        log::error!("the files helper's output thread failed");
    }
    read.context("could not read the files session's requests")
}

/// Moves the session socket's messages to the helper's `input` and the
/// helper's `output` back, until either side ends or `stop`.
fn relay_streams(
    socket: &mut Socket,
    mut input: impl Write,
    output: impl Read + Send + 'static,
    stop: &AtomicBool,
) -> Result<Ended> {
    let (sender, outgoing) = mpsc::sync_channel::<Outgoing>(OUTPUT_QUEUE);
    std::thread::Builder::new()
        .name("files-relay".into())
        .spawn(move || forward(output, &sender))
        .context("could not start the relay thread")?;
    let mut input = BufWriter::new(&mut input);
    pump(
        socket,
        &outgoing,
        stop,
        || true,
        |message| {
            let written = match &message {
                Incoming::Text(text) => write_frame(&mut input, TEXT, text.as_bytes()),
                Incoming::Bytes(bytes) => write_frame(&mut input, BINARY, bytes),
            };
            written.context("the files helper stopped taking requests")
        },
    )
}

/// Helper → socket. A helper that ends while the session is open (it
/// crashed or was stopped) ends the session with the reason.
fn forward(output: impl Read, sender: &SyncSender<Outgoing>) {
    let mut output = BufReader::new(output);
    let reason = loop {
        match read_frame(&mut output) {
            Ok(Some(Incoming::Text(text))) => {
                if sender.send(Outgoing::Text(text)).is_err() {
                    return;
                }
            }
            Ok(Some(Incoming::Bytes(bytes))) => {
                if sender.send(Outgoing::Bytes(bytes)).is_err() {
                    return;
                }
            }
            Ok(None) => break "The files helper stopped.".to_string(),
            Err(e) => break format!("The files helper's replies could not be read: {e}"),
        }
    };
    let _ = sender.send(Outgoing::Done(SessionEvent::Failed { message: reason }));
}

/// The helper's environment: a plain search path, the language, and the
/// agent's log level.
fn helper_environment() -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> =
        vec![("PATH".into(), crate::exec::spawn::UNIX_PATH.into())];
    for name in ["LANG", "BMUSTER_LOG"] {
        if let Some(value) = std::env::var_os(name).filter(|value| !value.is_empty()) {
            env.push((name.into(), value));
        }
    }
    env
}

/// Starts the helper in `unit` under `stdio-host` and waits for it to
/// connect back. Errors are the session's failure to start.
pub fn start(
    unit: &TransientUnit,
    stop: &AtomicBool,
    data_dir: &std::path::Path,
) -> Result<Started> {
    let program: PathBuf = crate::exec::unit::program(unit.manager())?;
    let launch = Launch {
        program: Program {
            arg0: program.clone().into_os_string(),
            path: program,
            // The storage requests read the scans there (SPEC-STORAGE 5).
            args: vec![
                "files-helper".into(),
                "--data-dir".into(),
                data_dir.as_os_str().to_os_string(),
            ],
        },
        env: helper_environment(),
        cwd: PathBuf::from("/"),
    };
    host::start(unit, HostProgram::Stdio, &launch, None, stop)
}

/// Relays the session socket to a started helper until the session ends,
/// then stops the unit.
pub fn relay(
    socket: &mut Socket,
    unit: &TransientUnit,
    started: Started,
    stop: &AtomicBool,
) -> Result<Ended> {
    let Started {
        channels,
        systemd_run,
    } = started;
    crate::diagnostics::ship_helper_stderr("files-helper", Some(channels.stderr));
    // The writer goes with the relay, which closes the helper's input.
    let ended = relay_streams(
        socket,
        InputWriter::new(channels.input),
        channels.stdout,
        stop,
    );
    // The helper finishes and exits, or is stopped.
    let _ = channels.exit.wait_for(EXIT_WAIT);
    unit.stop();
    systemd_run.end();
    ended
}

#[cfg(test)]
mod tests {
    use super::super::testing::{socket_pair, Server};
    use super::*;
    use bmuster_protocol::files::frame;
    use serde_json::{json, Value};

    #[test]
    fn frames_keep_their_kind_and_bytes() {
        let mut wire = Vec::new();
        write_message(&mut wire, &Outgoing::Text("{\"id\":1}".into())).unwrap();
        write_message(&mut wire, &Outgoing::Bytes(vec![0, 1, 2, 255])).unwrap();
        assert_eq!(&wire[..5], &[TEXT, 0, 0, 0, 8]);
        let mut reader = wire.as_slice();
        assert!(matches!(
            read_frame(&mut reader).unwrap(),
            Some(Incoming::Text(text)) if text == "{\"id\":1}"
        ));
        assert!(matches!(
            read_frame(&mut reader).unwrap(),
            Some(Incoming::Bytes(bytes)) if bytes == [0, 1, 2, 255]
        ));
        assert!(read_frame(&mut reader).unwrap().is_none());
    }

    #[test]
    fn broken_frames_are_errors() {
        let oversized = [BINARY, 0xff, 0xff, 0xff, 0xff];
        assert!(read_frame(&mut oversized.as_slice()).is_err());
        let unknown = [7, 0, 0, 0, 0];
        assert!(read_frame(&mut unknown.as_slice()).is_err());
        let cut_short = [TEXT, 0, 0, 0, 9, b'x'];
        assert!(read_frame(&mut cut_short.as_slice()).is_err());
    }

    /// The relay and a helper joined by pipes, as `stdio-host` joins them.
    fn start() -> (Server, std::thread::JoinHandle<Ended>) {
        let (mut client, server) = socket_pair();
        let (helper_in, relay_out) = std::io::pipe().unwrap();
        let (relay_in, helper_out) = std::io::pipe().unwrap();
        std::thread::spawn(move || serve(helper_in, helper_out, std::env::temp_dir()).unwrap());
        let agent = std::thread::spawn(move || {
            let stop = AtomicBool::new(false);
            relay_streams(&mut client, relay_out, relay_in, &stop).unwrap()
        });
        (Server::new(server), agent)
    }

    fn ask(server: &mut Server, request: Value) -> Value {
        server.send_text(&request.to_string());
        serde_json::from_str(&server.wait_for_text()).unwrap()
    }

    #[test]
    fn a_relayed_session_makes_folders_uploads_and_downloads() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_string_lossy().into_owned();
        let (mut server, agent) = start();
        let made = ask(
            &mut server,
            json!({ "id": 1, "op": "mkdir", "dir": base, "name": "New" }),
        );
        assert_eq!(made["type"], "done", "{made}");
        assert!(dir.path().join("New").is_dir());
        ask(
            &mut server,
            json!({ "id": 2, "op": "write-begin", "dir": base, "name": "up.bin", "size": 3, "replace": false }),
        );
        server.send_text(
            &json!({ "id": 3, "op": "write-chunk", "dir": base, "name": "up.bin", "offset": 0 })
                .to_string(),
        );
        server.send_bytes(&frame(3, b"abc"));
        let written: Value = serde_json::from_str(&server.wait_for_text()).unwrap();
        assert_eq!(written["result"]["partSize"], 3);
        let sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        let ended = ask(
            &mut server,
            json!({ "id": 4, "op": "write-end", "dir": base, "name": "up.bin", "size": 3, "sha256": sha }),
        );
        assert_eq!(ended["result"]["sha256"], sha);
        let path = dir.path().join("up.bin").to_string_lossy().into_owned();
        let read = ask(
            &mut server,
            json!({ "id": 5, "op": "read", "path": path, "offset": 1, "length": 2 }),
        );
        assert_eq!(read["result"]["bytes"], 2);
        assert_eq!(server.output(), b"\0\0\0\x05bc");
        let refused = ask(
            &mut server,
            json!({ "id": 6, "op": "list", "path": "relative/path" }),
        );
        assert_eq!(refused["code"], "invalid", "the helper checks paths");
        server.close();
        assert_eq!(agent.join().unwrap(), Ended::ServerClosed);
    }

    #[test]
    fn a_helper_that_stops_ends_the_session_with_the_reason() {
        let (mut client, server) = socket_pair();
        let (_helper_in, relay_out) = std::io::pipe().unwrap();
        let (relay_in, helper_out) = std::io::pipe().unwrap();
        drop(helper_out);
        let agent = std::thread::spawn(move || {
            let stop = AtomicBool::new(false);
            relay_streams(&mut client, relay_out, relay_in, &stop).unwrap()
        });
        let mut server = Server::new(server);
        let event: Value = serde_json::from_str(&server.wait_for_text()).unwrap();
        assert_eq!(event["type"], "failed");
        assert_eq!(event["message"], "The files helper stopped.");
        server.close();
        assert_eq!(agent.join().unwrap(), Ended::Finished);
    }
}
