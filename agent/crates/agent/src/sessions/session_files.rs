//! A `session-files` session (SPEC-SESSION-FILES): files sent through a
//! desktop session. The ticket was checked for `files` and
//! `desktop-control`; here the agent also checks that the desktop session
//! it names is live on this agent, in control, and the same person's
//! ([`super::desktops`]), and ends this session when that one ends.
//!
//! The agent opens no file. It reads who is on the screen itself
//! ([`crate::user_files::screen`]), refuses `target` and `send-begin` at
//! the sign-in screen and while locked, starts the user files helper as
//! that person ([`crate::user_files::start`]) and relays the frames to it
//! unchanged; every name and folder check happens in the helper.

use super::frames::{read_frame, write_frame, BINARY, TEXT};
use super::pump::{pump, Ended, Incoming, Outgoing};
use crate::socket::Socket;
use crate::user_files::screen::{self, OnScreen};
use crate::user_files::start::{self, Started};
use anyhow::Result;
use bmuster_protocol::files::split_frame;
use bmuster_protocol::session::SessionEvent;
use bmuster_protocol::user_files::{UserFilesError, UserFilesReply};
use std::io::{BufReader, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, SyncSender};
use std::sync::Arc;
use std::time::Duration;

/// Frames waiting for the socket.
const OUTPUT_QUEUE: usize = 32;
/// How often the linked desktop session is looked for.
const WATCH_EVERY: Duration = Duration::from_millis(500);

/// What the session needs from the machine: the screen and the helper.
/// Tests give their own.
pub trait Machine {
    fn on_screen(&mut self) -> OnScreen;
    fn start(&mut self, person: u32) -> Result<Started>;
}

/// The real machine.
pub struct System;

impl Machine for System {
    fn on_screen(&mut self) -> OnScreen {
        screen::now()
    }

    fn start(&mut self, person: u32) -> Result<Started> {
        start::start(person)
    }
}

/// The running helper and whom it runs as.
struct Running {
    person: u32,
    input: Box<dyn Write + Send>,
    _process: Box<dyn Send>,
}

fn reply_error(output: &SyncSender<Outgoing>, id: u32, code: UserFilesError, message: String) {
    if let Ok(text) = serde_json::to_string(&UserFilesReply::Error { id, code, message }) {
        let _ = output.send(Outgoing::Text(text));
    }
}

/// The request's id and op, read without trusting the rest.
fn id_and_op(text: &str) -> Option<(u32, String)> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let id = u32::try_from(value.get("id")?.as_u64()?).ok()?;
    Some((id, value.get("op")?.as_str()?.to_string()))
}

struct Relay<M: Machine> {
    machine: M,
    output: SyncSender<Outgoing>,
    helper: Option<Running>,
}

impl<M: Machine> Relay<M> {
    /// The helper for whoever is on the screen now, or the refusal.
    fn helper_for_screen(&mut self, id: u32) -> Option<&mut Running> {
        let person = match self.machine.on_screen() {
            OnScreen::Person { id } => id,
            other => {
                if let Some((code, message)) = screen::refusal(&other, "this machine") {
                    reply_error(&self.output, id, code, message);
                }
                return None;
            }
        };
        if self.helper.as_ref().is_some_and(|h| h.person != person) {
            // Another person is on the screen: their files are not the last one's.
            self.helper = None;
        }
        if self.helper.is_none() {
            match self.machine.start(person) {
                Ok(started) => {
                    crate::timeline::step("started", "user files helper");
                    let sender = self.output.clone();
                    let output = started.output;
                    let forwarded = std::thread::Builder::new()
                        .name("user-files-replies".into())
                        .spawn(move || forward(output, &sender));
                    if let Err(e) = forwarded {
                        reply_error(&self.output, id, UserFilesError::Io, format!("{e}"));
                        return None;
                    }
                    self.helper = Some(Running {
                        person,
                        input: started.input,
                        _process: started.process,
                    });
                }
                Err(error) => {
                    log::warn!("Could not start the user files helper: {error:#}");
                    reply_error(
                        &self.output,
                        id,
                        UserFilesError::Io,
                        format!(
                            "BMuster couldn't start its helper in the person's session: {error:#}"
                        ),
                    );
                    return None;
                }
            }
        }
        self.helper.as_mut()
    }

    fn send(&mut self, id: u32, kind: u8, payload: &[u8], needs_screen: bool) {
        let helper = if needs_screen {
            self.helper_for_screen(id)
        } else {
            match self.helper.as_mut() {
                Some(helper) => Some(helper),
                None => {
                    reply_error(
                        &self.output,
                        id,
                        UserFilesError::Invalid,
                        "That file was not started; start it again.".into(),
                    );
                    None
                }
            }
        };
        let Some(helper) = helper else {
            return;
        };
        if let Err(error) = write_frame(&mut helper.input, kind, payload) {
            log::warn!("The user files helper stopped taking requests: {error}");
            self.helper = None;
            reply_error(
                &self.output,
                id,
                UserFilesError::Io,
                "BMuster's helper on the machine stopped. Send the files again.".into(),
            );
        }
    }

    fn take(&mut self, message: Incoming) {
        match message {
            Incoming::Text(text) => {
                let Some((id, op)) = id_and_op(&text) else {
                    log::warn!("Ignoring a session-files request this agent cannot read.");
                    return;
                };
                // Nothing reaches the clipboard or a new file while nobody, or a locked screen, is there.
                let needs_screen = matches!(op.as_str(), "target" | "send-begin" | "offer");
                self.send(id, TEXT, text.as_bytes(), needs_screen);
            }
            Incoming::Bytes(bytes) => match split_frame(&bytes) {
                Some((id, _)) => self.send(id, BINARY, &bytes, false),
                None => log::warn!("Ignoring a binary frame too short for a request id."),
            },
        }
    }
}

/// Helper → socket, until the helper's output closes.
fn forward(output: Box<dyn std::io::Read + Send>, sender: &SyncSender<Outgoing>) {
    let mut output = BufReader::new(output);
    loop {
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
            Ok(None) => return,
            Err(e) => {
                log::warn!("The user files helper's replies could not be read: {e}");
                return;
            }
        }
    }
}

/// Runs the session once its link to the desktop session was checked.
pub fn run(
    socket: &mut Socket,
    machine: impl Machine,
    desktop_session_id: &str,
    stop: &Arc<AtomicBool>,
) -> Result<Ended> {
    let (output, outgoing) = mpsc::sync_channel::<Outgoing>(OUTPUT_QUEUE);
    let over = Arc::new(AtomicBool::new(false));
    {
        let (over, output, desktop) = (
            Arc::clone(&over),
            output.clone(),
            desktop_session_id.to_string(),
        );
        std::thread::Builder::new()
            .name("session-files-watch".into())
            .spawn(move || {
                while !over.load(Ordering::SeqCst) {
                    if !super::desktops::is_live(&desktop) {
                        let _ = output.send(Outgoing::Done(SessionEvent::Failed {
                            message: "The desktop session ended.".into(),
                        }));
                        return;
                    }
                    std::thread::sleep(WATCH_EVERY);
                }
            })?;
    }
    let mut relay = Relay {
        machine,
        output,
        helper: None,
    };
    let ended = pump(
        socket,
        &outgoing,
        stop,
        || true,
        |message| {
            relay.take(message);
            Ok(())
        },
    );
    over.store(true, Ordering::SeqCst);
    // Dropping the relay ends the helper; what it saved stays saved.
    drop(relay);
    ended
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::testing::{socket_pair, Server};
    use super::*;
    use serde_json::{json, Value};

    /// A machine whose screen the test sets, and whose helper is the real
    /// request loop over pipes.
    struct Fake {
        screen: Arc<std::sync::Mutex<OnScreen>>,
        started: Arc<std::sync::Mutex<Vec<u32>>>,
    }

    impl Machine for Fake {
        fn on_screen(&mut self) -> OnScreen {
            self.screen.lock().unwrap().clone()
        }

        fn start(&mut self, person: u32) -> Result<Started> {
            self.started.lock().unwrap().push(person);
            let (helper_in, input) = std::io::pipe()?;
            let (output, helper_out) = std::io::pipe()?;
            std::thread::spawn(move || {
                let _ = crate::user_files::serve::serve(helper_in, helper_out);
            });
            Ok(Started {
                input: Box::new(input),
                output: Box::new(output),
                process: Box::new(()),
            })
        }
    }

    /// SF11 and SF2: refused while locked or nobody is there, the helper
    /// started for the person on the screen, and the session ends with
    /// the desktop session.
    #[test]
    fn sf11_refusals_then_the_person_then_the_end_of_the_desktop() {
        let _env = crate::user_files::ENV_LOCK
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("HOME", home.path());
        let listed = super::super::desktops::enter("d-run", "u1", true);
        let screen = Arc::new(std::sync::Mutex::new(OnScreen::Locked));
        let started = Arc::new(std::sync::Mutex::new(Vec::new()));
        let fake = Fake {
            screen: Arc::clone(&screen),
            started: Arc::clone(&started),
        };
        let (mut client, server) = socket_pair();
        let agent = std::thread::spawn(move || {
            let stop = Arc::new(AtomicBool::new(false));
            run(&mut client, fake, "d-run", &stop).unwrap()
        });
        let mut server = Server::new(server);
        let mut ask = |request: Value| -> Value {
            server.send_text(&request.to_string());
            serde_json::from_str(&server.wait_for_text()).unwrap()
        };
        let locked = ask(json!({ "id": 1, "op": "target" }));
        assert_eq!(locked["code"], "locked");
        *screen.lock().unwrap() = OnScreen::Nobody;
        let nobody =
            ask(json!({ "id": 2, "op": "send-begin", "transferId": "ab", "name": "a", "size": 1 }));
        assert_eq!(nobody["code"], "nobody");
        assert!(started.lock().unwrap().is_empty(), "no helper started");
        let early =
            ask(json!({ "id": 3, "op": "send-end", "transferId": "ab", "size": 1, "sha256": "x" }));
        assert_eq!(early["code"], "invalid");
        *screen.lock().unwrap() = OnScreen::Person { id: 1000 };
        let target = ask(json!({ "id": 4, "op": "target" }));
        assert_eq!(target["id"], 4);
        assert!(target["result"]["free"].as_u64().unwrap() > 0, "{target}");
        assert_eq!(*started.lock().unwrap(), [1000]);
        drop(listed);
        let ended: Value = serde_json::from_str(&server.wait_for_text()).unwrap();
        assert_eq!(ended["type"], "failed");
        assert_eq!(ended["message"], "The desktop session ended.");
        server.close();
        agent.join().unwrap();
    }
}
