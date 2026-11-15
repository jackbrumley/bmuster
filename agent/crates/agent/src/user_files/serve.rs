//! `bmuster-agent user-files`: the helper's request loop, as the person
//! (SPEC-SESSION-FILES 4.3). Requests arrive as frames on one stream (the
//! connect-back socket on Linux, stdin on Windows) and are answered in
//! order on the other; a chunk's request is followed by its data frame.
//! The helper holds no agent key, ticket or credential.

use super::folder::{self, Folder};
use super::notice;
use super::write::Sends;
use super::UserError;
use crate::sessions::frames::{read_frame, write_message};
use crate::sessions::pump::{Incoming, Outgoing};
use anyhow::{Context as _, Result};
use bmuster_protocol::files::split_frame;
use bmuster_protocol::user_files::{
    UserFilesOp, UserFilesReply, UserFilesRequest, UserFilesResult,
};
use std::io::{BufReader, BufWriter, Read, Write};
use std::time::SystemTime;

/// The helper's state: the folder, opened on first use.
#[derive(Default)]
struct Helper {
    sends: Option<Sends>,
    /// A chunk's request waits for its data frame.
    awaiting: Option<(u32, String, u64)>,
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

    fn handle(&mut self, op: UserFilesOp) -> Result<UserFilesResult, UserError> {
        match op {
            UserFilesOp::Target => {
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
            UserFilesOp::SendBegin {
                transfer_id,
                name,
                size,
            } => self.sends()?.begin(&transfer_id, &name, size),
            UserFilesOp::SendEnd {
                transfer_id,
                size,
                sha256,
            } => self.sends()?.end(&transfer_id, size, &sha256),
            UserFilesOp::SendCancel { transfer_id } => self.sends()?.cancel(&transfer_id),
            UserFilesOp::SendFinish {
                batch_id,
                transfer_ids,
                sender,
            } => {
                let names = self.sends()?.saved_names(&transfer_ids);
                if !names.is_empty() {
                    match notice::folder() {
                        Some(dir) => {
                            if let Err(error) = notice::write(&dir, &batch_id, &sender, &names) {
                                log::warn!("Could not leave the tray notice: {error}");
                            }
                        }
                        None => log::warn!("No private folder for the tray notice."),
                    }
                }
                Ok(UserFilesResult::Finished {
                    on_clipboard: false,
                })
            }
            UserFilesOp::SendChunk { .. } => {
                Err(UserError::invalid("A chunk comes with its data."))
            }
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
                Ok(request) => (request.id, self.handle(request.op)),
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
        Some(match outcome {
            Ok(result) => UserFilesReply::Done { id, result },
            Err(error) => UserFilesReply::Error {
                id,
                code: error.code,
                message: error.message,
            },
        })
    }
}

/// Serves requests from `input` until it closes, replying on `output`.
pub fn serve(input: impl Read, output: impl Write) -> Result<()> {
    let mut input = BufReader::new(input);
    let mut output = BufWriter::new(output);
    let mut helper = Helper::default();
    while let Some(message) = read_frame(&mut input).context("could not read a request")? {
        if let Some(reply) = helper.take(message) {
            let text = serde_json::to_string(&reply)?;
            write_message(&mut output, &Outgoing::Text(text)).context("could not reply")?;
        }
    }
    Ok(())
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
    use bmuster_protocol::files::frame;

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
            serde_json::json!({ "id": 5, "op": "send-finish", "batchId": "4f1e2d3c-0000-4000-8000-000000000001", "transferIds": [id], "sender": "Jack" }),
            serde_json::json!({ "id": 6, "op": "send-begin", "transferId": id, "name": "../x", "size": 3 }),
        ] {
            write_frame(&mut wire, TEXT, text.to_string().as_bytes()).unwrap();
        }
        let mut replies = Vec::new();
        serve(wire.as_slice(), &mut replies).unwrap();
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
        assert_eq!(answers[4]["result"]["onClipboard"], false);
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
