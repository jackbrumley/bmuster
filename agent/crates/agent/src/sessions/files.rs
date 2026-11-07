//! A files session (SPEC-FILES): numbered requests from the server, each
//! answered on its own thread so a long read or a big delete never holds up
//! a listing. Only a `files` ticket reaches here; a terminal or exec ticket
//! never runs a file action.

use super::pump::{pump, Ended, Incoming, Outgoing};
use crate::files::transfer::{self, Credit};
use crate::files::{ops, roots, FileError};
use crate::socket::Socket;
use anyhow::Result;
use bmuster_protocol::files::{
    frame, split_frame, ErrorCode, FilesOp, FilesReply, FilesRequest, FilesResult,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex};

/// Frames waiting for the socket before the request threads wait too.
pub const OUTPUT_QUEUE: usize = 32;
/// Requests running at once in one session.
const MAX_RUNNING: usize = 16;

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Runs one request that is not part of a read or a chunk.
fn handle(op: &FilesOp) -> Result<FilesResult, FileError> {
    match op {
        FilesOp::Roots => Ok(roots::roots()),
        FilesOp::List { path } => ops::list(path),
        FilesOp::Stat { path } => ops::stat(path),
        FilesOp::Mkdir { dir, name } => ops::mkdir(dir, name),
        FilesOp::Rename { dir, from, to } => ops::rename(dir, from, to),
        FilesOp::Delete {
            dir,
            names,
            recursive,
        } => ops::delete(dir, names, *recursive),
        FilesOp::WriteBegin {
            dir,
            name,
            size,
            replace,
        } => transfer::begin(dir, name, *size, *replace),
        FilesOp::WriteEnd {
            dir,
            name,
            size,
            sha256,
        } => transfer::end(dir, name, *size, sha256),
        FilesOp::WriteCancel { dir, name } => transfer::cancel(dir, name),
        FilesOp::Read { .. }
        | FilesOp::WriteChunk { .. }
        | FilesOp::Ack { .. }
        | FilesOp::Cancel => Err(FileError::invalid("Not a request on its own.".into())),
    }
}

fn reply(output: &SyncSender<Outgoing>, id: u32, outcome: Result<FilesResult, FileError>) {
    let message = match outcome {
        Ok(result) => FilesReply::Done { id, result },
        Err(error) => FilesReply::Error {
            id,
            code: error.code,
            message: error.message,
        },
    };
    match serde_json::to_string(&message) {
        Ok(text) => {
            let _ = output.send(Outgoing::Text(text));
        }
        Err(e) => log::error!("Could not write a files reply: {e}"),
    }
}

/// The state shared by the request threads of one session.
struct Shared {
    output: SyncSender<Outgoing>,
    reads: Mutex<HashMap<u32, Arc<Credit>>>,
    running: AtomicUsize,
    stop: Arc<AtomicBool>,
}

impl Shared {
    /// Runs `work` on its own thread and replies with its outcome, or says
    /// the session is busy.
    fn spawn(
        self: &Arc<Self>,
        id: u32,
        work: impl FnOnce(&Shared) -> Result<FilesResult, FileError> + Send + 'static,
    ) {
        if self.running.fetch_add(1, Ordering::SeqCst) >= MAX_RUNNING {
            self.running.fetch_sub(1, Ordering::SeqCst);
            reply(
                &self.output,
                id,
                Err(FileError::new(
                    ErrorCode::Busy,
                    "The machine is busy with other file requests.".into(),
                )),
            );
            return;
        }
        let shared = Arc::clone(self);
        let started = std::thread::Builder::new()
            .name(format!("files-{id}"))
            .spawn(move || {
                let outcome = work(&shared);
                reply(&shared.output, id, outcome);
                shared.running.fetch_sub(1, Ordering::SeqCst);
            });
        if let Err(e) = started {
            self.running.fetch_sub(1, Ordering::SeqCst);
            reply(
                &self.output,
                id,
                Err(FileError::new(
                    ErrorCode::Busy,
                    format!("Could not start a thread: {e}"),
                )),
            );
        }
    }

    fn read(self: &Arc<Self>, id: u32, path: String, offset: u64, length: u64) {
        let credit = Arc::new(Credit::default());
        lock(&self.reads).insert(id, Arc::clone(&credit));
        self.spawn(id, move |shared| {
            let outcome = transfer::read(&path, offset, length, &credit, &shared.stop, |bytes| {
                shared
                    .output
                    .send(Outgoing::Bytes(frame(id, &bytes)))
                    .is_ok()
            });
            lock(&shared.reads).remove(&id);
            outcome
        });
    }
}

/// One files session's requests, wherever its messages come from: the
/// session socket (in the agent's process) or the files helper's input
/// (in a transient unit, `files_helper`).
pub struct Requests {
    shared: Arc<Shared>,
    /// A chunk's request comes first; its data follows in a binary frame.
    awaiting: HashMap<u32, (String, String, u64)>,
}

impl Requests {
    /// Replies and read data go to `output`; `stop` ends reads early.
    pub fn new(output: SyncSender<Outgoing>, stop: Arc<AtomicBool>) -> Self {
        Self {
            shared: Arc::new(Shared {
                output,
                reads: Mutex::new(HashMap::new()),
                running: AtomicUsize::new(0),
                stop,
            }),
            awaiting: HashMap::new(),
        }
    }

    /// Starts what one message from the server asks for.
    pub fn take(&mut self, message: Incoming) {
        match message {
            Incoming::Text(text) => match serde_json::from_str::<FilesRequest>(&text) {
                Ok(request) => dispatch(&self.shared, &mut self.awaiting, request),
                Err(e) => log::warn!("Ignoring a files request this agent does not know: {e}"),
            },
            Incoming::Bytes(bytes) => match split_frame(&bytes) {
                Some((id, data)) => match self.awaiting.remove(&id) {
                    Some((dir, name, offset)) => {
                        let data = data.to_vec();
                        self.shared
                            .spawn(id, move |_| transfer::chunk(&dir, &name, offset, &data));
                    }
                    None => log::warn!("Ignoring data for request {id}, which is not a chunk."),
                },
                None => log::warn!("Ignoring a binary frame too short for a request id."),
            },
        }
    }

    /// The session is over: reads still running stop.
    pub fn finish(self) {
        for credit in lock(&self.shared.reads).values() {
            credit.cancel();
        }
    }
}

/// Serves file requests over `socket` in the agent's own process until the
/// server closes it or `stop`.
pub fn run(socket: &mut Socket, stop: &Arc<AtomicBool>) -> Result<Ended> {
    let (output, outgoing) = mpsc::sync_channel::<Outgoing>(OUTPUT_QUEUE);
    let mut requests = Requests::new(output, Arc::clone(stop));
    let ended = pump(
        socket,
        &outgoing,
        stop,
        || true,
        |message| {
            requests.take(message);
            Ok(())
        },
    );
    requests.finish();
    ended
}

fn dispatch(
    shared: &Arc<Shared>,
    awaiting: &mut HashMap<u32, (String, String, u64)>,
    request: FilesRequest,
) {
    let id = request.id;
    match request.op {
        FilesOp::Ack { bytes } => {
            if let Some(credit) = lock(&shared.reads).get(&id) {
                credit.ack(bytes);
            }
        }
        FilesOp::Cancel => {
            if let Some(credit) = lock(&shared.reads).get(&id) {
                credit.cancel();
            }
        }
        FilesOp::Read {
            path,
            offset,
            length,
        } => shared.read(id, path, offset, length),
        FilesOp::WriteChunk { dir, name, offset } => {
            awaiting.insert(id, (dir, name, offset));
        }
        op => shared.spawn(id, move |_| handle(&op)),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::testing::{socket_pair, Server};
    use super::*;
    use serde_json::{json, Value};

    fn start() -> (Server, std::thread::JoinHandle<Ended>) {
        let (mut client, server) = socket_pair();
        let agent = std::thread::spawn(move || {
            let stop = Arc::new(AtomicBool::new(false));
            run(&mut client, &stop).unwrap()
        });
        (Server::new(server), agent)
    }

    fn ask(server: &mut Server, request: Value) -> Value {
        server.send_text(&request.to_string());
        serde_json::from_str(&server.wait_for_text()).unwrap()
    }

    #[test]
    fn requests_are_answered_by_id() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_string_lossy().into_owned();
        std::fs::write(dir.path().join("a.txt"), b"hello").unwrap();
        let (mut server, agent) = start();
        let made = ask(
            &mut server,
            json!({ "id": 1, "op": "mkdir", "dir": base, "name": "New" }),
        );
        assert_eq!(made["type"], "done");
        assert_eq!(made["id"], 1);
        let listing = ask(&mut server, json!({ "id": 2, "op": "list", "path": base }));
        let names: Vec<&str> = listing["result"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();
        assert!(
            names.contains(&"New") && names.contains(&"a.txt"),
            "{names:?}"
        );
        let refused = ask(
            &mut server,
            json!({ "id": 3, "op": "list", "path": "relative/path" }),
        );
        assert_eq!(refused["type"], "error");
        assert_eq!(refused["code"], "invalid");
        server.close();
        assert_eq!(agent.join().unwrap(), Ended::ServerClosed);
    }

    #[test]
    fn a_read_streams_framed_data_then_its_total() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.bin");
        std::fs::write(&path, b"0123456789").unwrap();
        let (mut server, agent) = start();
        let done = ask(
            &mut server,
            json!({ "id": 9, "op": "read", "path": path.to_string_lossy(), "offset": 3, "length": 4 }),
        );
        assert_eq!(done["result"]["bytes"], 4);
        assert_eq!(server.output(), b"\0\0\0\x093456");
        server.close();
        agent.join().unwrap();
    }

    #[test]
    fn a_chunk_is_its_request_then_its_data() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_string_lossy().into_owned();
        let (mut server, agent) = start();
        let begun = ask(
            &mut server,
            json!({ "id": 1, "op": "write-begin", "dir": base, "name": "up.bin", "size": 3, "replace": false }),
        );
        assert_eq!(begun["result"]["partSize"], 0);
        server.send_text(
            &json!({ "id": 2, "op": "write-chunk", "dir": base, "name": "up.bin", "offset": 0 })
                .to_string(),
        );
        server.send_bytes(&frame(2, b"abc"));
        let written: Value = serde_json::from_str(&server.wait_for_text()).unwrap();
        assert_eq!(written["result"]["partSize"], 3);
        let sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        let ended = ask(
            &mut server,
            json!({ "id": 3, "op": "write-end", "dir": base, "name": "up.bin", "size": 3, "sha256": sha }),
        );
        assert_eq!(ended["result"]["sha256"], sha);
        assert_eq!(std::fs::read(dir.path().join("up.bin")).unwrap(), b"abc");
        server.close();
        agent.join().unwrap();
    }
}
