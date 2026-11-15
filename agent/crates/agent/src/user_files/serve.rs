//! `bmuster-agent user-files`: the helper's request loop, as the person
//! (SPEC-SESSION-FILES 4.3). Requests arrive as frames on one stream (the
//! connect-back socket on Linux, stdin on Windows) and are answered in
//! order on the other; a chunk's request is followed by its data frame.
//! The helper holds no agent key, ticket or credential.

use super::clipboard::{self, FileClipboard};
use super::folder::{self, Folder};
use super::notice;
use super::offers::{self, Offers};
use super::write::Sends;
use super::UserError;
use crate::files::transfer::Credit;
use crate::sessions::frames::{read_frame, write_message};
use crate::sessions::pump::{Incoming, Outgoing};
use anyhow::{Context as _, Result};
use bmuster_protocol::files::{frame, split_frame};
use bmuster_protocol::user_files::{
    UserFilesError, UserFilesOp, UserFilesReply, UserFilesRequest, UserFilesResult,
};
use std::collections::HashMap;
use std::io::{BufReader, BufWriter, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Instant, SystemTime};

/// Frames waiting for the output before the request threads wait too.
const OUTPUT_QUEUE: usize = 32;

/// Makes the person's clipboard, on first use.
type MakeClipboard = fn() -> Box<dyn FileClipboard>;

type Reads = Arc<Mutex<HashMap<u32, Arc<Credit>>>>;

/// The helper's state: the folder and the clipboard, opened on first use.
struct Helper {
    sends: Option<Sends>,
    /// A chunk's request waits for its data frame.
    awaiting: Option<(u32, String, u64)>,
    offers: Offers,
    clipboard: Option<Box<dyn FileClipboard>>,
    make_clipboard: MakeClipboard,
    output: SyncSender<Outgoing>,
    /// Reads running on their own threads, by request id.
    reads: Reads,
    stop: Arc<AtomicBool>,
}

fn reply_of(id: u32, outcome: Result<UserFilesResult, UserError>) -> UserFilesReply {
    match outcome {
        Ok(result) => UserFilesReply::Done { id, result },
        Err(error) => UserFilesReply::Error {
            id,
            code: error.code,
            message: error.message,
        },
    }
}

fn send_reply(output: &SyncSender<Outgoing>, reply: &UserFilesReply) {
    match serde_json::to_string(reply) {
        Ok(text) => {
            let _ = output.send(Outgoing::Text(text));
        }
        Err(error) => log::error!("Could not write a reply: {error}"),
    }
}

fn credit_of(reads: &Reads, id: u32) -> Option<Arc<Credit>> {
    reads
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&id)
        .cloned()
}

impl Helper {
    fn sends(&mut self) -> Result<&mut Sends, UserError> {
        if self.sends.is_none() {
            let (downloads, label, user) = folder::this_person()?;
            let opened = Folder::open(&downloads, label, user)?;
            self.sends = Some(Sends::new(opened, SystemTime::now()));
        }
        self.sends
            .as_mut()
            .ok_or_else(|| UserError::invalid("The folder could not be opened."))
    }

    fn clipboard(&mut self) -> &mut dyn FileClipboard {
        let make = self.make_clipboard;
        self.clipboard.get_or_insert_with(make).as_mut()
    }

    /// The drop is over: the tray notice, and the files on the clipboard
    /// when Share clipboard is on (SF20). Only files this helper saved.
    fn finish(
        &mut self,
        batch_id: &str,
        transfer_ids: &[String],
        sender: &str,
        share: bool,
    ) -> Result<UserFilesResult, UserError> {
        let sends = self.sends()?;
        let names = sends.saved_names(transfer_ids);
        let paths = sends.saved_paths(transfer_ids);
        if names.is_empty() {
            return Ok(UserFilesResult::Finished {
                on_clipboard: false,
            });
        }
        match notice::folder() {
            Some(dir) => {
                if let Err(error) = notice::write(&dir, batch_id, sender, &names) {
                    log::warn!("Could not leave the tray notice: {error}");
                }
            }
            None => log::warn!("No private folder for the tray notice."),
        }
        if !share {
            return Ok(UserFilesResult::Finished {
                on_clipboard: false,
            });
        }
        let on_clipboard = match self.clipboard().put(&paths) {
            Ok(()) => {
                log::info!("Put {} saved files on the clipboard.", paths.len());
                self.offers.put_by_us(paths);
                true
            }
            Err(error) => {
                log::warn!("Could not put the saved files on the clipboard: {error}");
                false
            }
        };
        Ok(UserFilesResult::Finished { on_clipboard })
    }

    fn target(&mut self) -> Result<UserFilesResult, UserError> {
        let sends = self.sends()?;
        let folder = sends.folder();
        let free = folder
            .free()
            .map_err(|e| UserError::io(&e, "files", &folder.user, &folder.label))?;
        Ok(UserFilesResult::Target {
            user: folder.user.clone(),
            folder_label: folder.label.clone(),
            free,
        })
    }

    /// One request; `None` when it is answered later or not at all.
    fn handle(&mut self, id: u32, op: UserFilesOp) -> Option<Result<UserFilesResult, UserError>> {
        Some(match op {
            UserFilesOp::Target => self.target(),
            UserFilesOp::SendBegin {
                transfer_id,
                name,
                size,
            } => self
                .sends()
                .and_then(|sends| sends.begin(&transfer_id, &name, size)),
            UserFilesOp::SendEnd {
                transfer_id,
                size,
                sha256,
            } => self
                .sends()
                .and_then(|sends| sends.end(&transfer_id, size, &sha256)),
            UserFilesOp::SendCancel { transfer_id } => {
                self.sends().and_then(|sends| sends.cancel(&transfer_id))
            }
            UserFilesOp::SendFinish {
                batch_id,
                transfer_ids,
                sender,
                clipboard,
            } => self.finish(&batch_id, &transfer_ids, &sender, clipboard),
            UserFilesOp::SendChunk { .. } => {
                Err(UserError::invalid("A chunk comes with its data."))
            }
            UserFilesOp::Offer => {
                let mut offers = std::mem::take(&mut self.offers);
                let looked = offers.look(self.clipboard(), Instant::now());
                self.offers = offers;
                looked
            }
            UserFilesOp::OfferStat { offer_id } => self.offers.walk(&offer_id, Instant::now()),
            UserFilesOp::OfferRead {
                offer_id,
                entry,
                offset,
                length,
            } => match self.offers.entry(&offer_id, entry, Instant::now()) {
                Ok(entry) => {
                    self.read(id, entry, offset, length);
                    return None;
                }
                Err(error) => Err(error),
            },
            UserFilesOp::Ack { bytes } => {
                if let Some(credit) = credit_of(&self.reads, id) {
                    credit.ack(bytes);
                }
                return None;
            }
            UserFilesOp::Cancel => {
                if let Some(credit) = credit_of(&self.reads, id) {
                    credit.cancel();
                }
                return None;
            }
        })
    }

    /// Streams one walked file on its own thread, so acknowledgements and
    /// other requests keep being read.
    fn read(&self, id: u32, entry: offers::Entry, offset: u64, length: u64) {
        let credit = Arc::new(Credit::default());
        self.reads
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(id, Arc::clone(&credit));
        let output = self.output.clone();
        let reads = Arc::clone(&self.reads);
        let stop = Arc::clone(&self.stop);
        let started = std::thread::Builder::new()
            .name(format!("user-files-read-{id}"))
            .spawn(move || {
                let outcome = offers::read(&entry, offset, length, &credit, &stop, |bytes| {
                    output.send(Outgoing::Bytes(frame(id, &bytes))).is_ok()
                });
                reads
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .remove(&id);
                send_reply(&output, &reply_of(id, outcome));
            });
        if let Err(error) = started {
            let busy = UserError::new(UserFilesError::Busy, format!("{error}"));
            send_reply(&self.output, &reply_of(id, Err(busy)));
        }
    }

    /// One frame in; the reply to send, if any.
    fn take(&mut self, message: Incoming) -> Option<UserFilesReply> {
        let (id, outcome) = match message {
            Incoming::Text(text) => match serde_json::from_str::<UserFilesRequest>(&text) {
                Ok(UserFilesRequest {
                    id,
                    op:
                        UserFilesOp::SendChunk {
                            transfer_id,
                            offset,
                        },
                }) => {
                    self.awaiting = Some((id, transfer_id, offset));
                    return None;
                }
                Ok(request) => (request.id, self.handle(request.id, request.op)?),
                Err(e) => {
                    log::warn!("Ignoring a request this helper does not know: {e}");
                    return None;
                }
            },
            Incoming::Bytes(bytes) => {
                let (frame_id, data) = split_frame(&bytes)?;
                let (id, transfer_id, offset) = self.awaiting.take()?;
                if id != frame_id {
                    return None;
                }
                let outcome = self
                    .sends()
                    .and_then(|sends| sends.chunk(&transfer_id, offset, data));
                (id, outcome)
            }
        };
        Some(reply_of(id, outcome))
    }
}

/// Serves requests from `input` until it closes, replying on `output`.
pub fn serve(input: impl Read, output: impl Write + Send + 'static) -> Result<()> {
    serve_with(input, output, clipboard::system)
}

/// As [`serve`], with the clipboard `make_clipboard` gives (tests give a fake).
pub fn serve_with(
    input: impl Read,
    output: impl Write + Send + 'static,
    make_clipboard: MakeClipboard,
) -> Result<()> {
    let (sender, outgoing) = mpsc::sync_channel::<Outgoing>(OUTPUT_QUEUE);
    let writer = std::thread::Builder::new()
        .name("user-files-output".into())
        .spawn(move || {
            let mut output = BufWriter::new(output);
            for message in outgoing {
                if let Err(error) = write_message(&mut output, &message) {
                    log::debug!("The user files helper's output closed: {error}");
                    return;
                }
            }
        })
        .context("could not start the output thread")?;
    let stop = Arc::new(AtomicBool::new(false));
    let reads: Reads = Arc::new(Mutex::new(HashMap::new()));
    let mut helper = Helper {
        sends: None,
        awaiting: None,
        offers: Offers::default(),
        clipboard: None,
        make_clipboard,
        output: sender.clone(),
        reads: Arc::clone(&reads),
        stop: Arc::clone(&stop),
    };
    let mut input = BufReader::new(input);
    let read = loop {
        match read_frame(&mut input) {
            Ok(Some(message)) => {
                if let Some(reply) = helper.take(message) {
                    send_reply(&sender, &reply);
                }
            }
            Ok(None) => break Ok(()),
            Err(error) => break Err(error),
        }
    };
    stop.store(true, Ordering::SeqCst);
    for credit in reads
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .values()
    {
        credit.cancel();
    }
    // The clipboard's owner goes with the helper; reads still running end.
    drop(helper);
    drop(sender);
    if writer.join().is_err() {
        log::error!("the user files helper's output thread failed");
    }
    read.context("could not read the requests")
}

/// The helper's entry point. Linux: connects back to the agent's socket
/// and serves on it. Refuses to run as root: files must be the person's.
#[cfg(unix)]
pub fn run(socket: &std::path::Path) -> Result<()> {
    // SAFETY: geteuid cannot fail.
    if unsafe { libc::geteuid() } == 0 {
        anyhow::bail!("The user files helper never runs as root");
    }
    let stream = std::os::unix::net::UnixStream::connect(socket)
        .with_context(|| format!("could not connect to {}", socket.display()))?;
    serve(stream.try_clone()?, stream)
}

/// Windows: serves on stdin and stdout, the pipes the service gave it.
#[cfg(windows)]
pub fn run() -> Result<()> {
    serve(std::io::stdin(), std::io::stdout())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::sessions::frames::{write_frame, BINARY, TEXT};
    use crate::user_files::clipboard::fake::Fake;

    static FAKE: std::sync::LazyLock<Fake> = std::sync::LazyLock::new(Fake::default);

    fn fake_clipboard() -> Box<dyn FileClipboard> {
        Box::new(FAKE.clone())
    }

    /// A writer the test can read after the helper's thread is done.
    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_drop_is_served_in_order_with_chunks_and_a_notice() {
        let _env = crate::user_files::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let home = tempfile::tempdir().unwrap();
        let runtime = tempfile::tempdir().unwrap();
        // The helper reads its own environment, as the person's unit sets it.
        std::env::set_var("HOME", home.path());
        std::env::set_var("USER", "kim");
        std::env::set_var("XDG_RUNTIME_DIR", runtime.path());
        std::env::remove_var("XDG_CONFIG_HOME");
        let id = "0b5c2d6e-1111-4222-8333-444455556666";
        let sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        let mut wire = Vec::new();
        for text in [
            serde_json::json!({ "id": 1, "op": "target" }),
            serde_json::json!({ "id": 2, "op": "send-begin", "transferId": id, "name": "a.txt", "size": 3 }),
            serde_json::json!({ "id": 3, "op": "send-chunk", "transferId": id, "offset": 0 }),
        ] {
            write_frame(&mut wire, TEXT, text.to_string().as_bytes()).unwrap();
        }
        write_frame(&mut wire, BINARY, &frame(3, b"abc")).unwrap();
        for text in [
            serde_json::json!({ "id": 4, "op": "send-end", "transferId": id, "size": 3, "sha256": sha }),
            serde_json::json!({ "id": 5, "op": "send-finish", "batchId": "4f1e2d3c-0000-4000-8000-000000000001", "transferIds": [id], "sender": "Jack", "clipboard": true }),
            serde_json::json!({ "id": 6, "op": "send-begin", "transferId": id, "name": "../x", "size": 3 }),
        ] {
            write_frame(&mut wire, TEXT, text.to_string().as_bytes()).unwrap();
        }
        let replies = Arc::new(Mutex::new(Vec::new()));
        serve_with(
            wire.as_slice(),
            Shared(Arc::clone(&replies)),
            fake_clipboard,
        )
        .unwrap();
        let replies = replies.lock().unwrap().clone();
        let mut reader = replies.as_slice();
        let mut answers = Vec::new();
        while let Some(Incoming::Text(text)) = read_frame(&mut reader).unwrap() {
            answers.push(serde_json::from_str::<serde_json::Value>(&text).unwrap());
        }
        assert_eq!(answers.len(), 6, "{answers:?}");
        assert_eq!(answers[0]["result"]["folderLabel"], "Downloads/BMuster");
        assert_eq!(answers[0]["result"]["user"], "kim");
        assert_eq!(answers[2]["result"]["partSize"], 3);
        assert_eq!(answers[3]["result"]["savedAs"], "a.txt");
        assert_eq!(answers[4]["result"]["onClipboard"], true);
        // SF20: the saved file, and only it, is on the clipboard.
        assert_eq!(
            *FAKE.held.lock().unwrap(),
            Some(vec![bmuster_desktop::clipboard::files::CopiedItem::Local(
                home.path().join("Downloads/BMuster/a.txt")
            )])
        );
        assert_eq!(answers[5]["code"], "invalid");
        assert_eq!(
            std::fs::read(home.path().join("Downloads/BMuster/a.txt")).unwrap(),
            b"abc"
        );
        assert_eq!(
            std::fs::read_dir(runtime.path().join("bmuster/notices"))
                .unwrap()
                .count(),
            1
        );
    }
}
