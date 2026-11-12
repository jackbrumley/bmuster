//! SPEC-DESKTOP 21.9: the Wayland portal clipboard against a fake portal.
use super::*;
use std::sync::Arc;
use std::time::Instant;

fn run<T>(future: impl std::future::Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(future)
}

/// What the fake desktop's clipboard holds, per type.
#[derive(Clone)]
enum Held {
    /// Writes these bytes, then closes.
    Bytes(Vec<u8>),
    /// Never writes or closes (a stuck owner).
    Stuck,
    /// The portal refuses the type.
    Refused,
}

#[derive(Default)]
struct Fake {
    held: HashMap<String, Held>,
    /// The write end of the last paste, read back by the test.
    pasted: Mutex<Option<std::io::PipeReader>>,
    offered: Mutex<Vec<String>>,
    reads: Mutex<Vec<String>>,
    done: Mutex<Vec<(u32, bool)>>,
    refuse_set: bool,
    /// Keeps stuck pipes open for the test's length.
    stuck: Mutex<Vec<std::io::PipeWriter>>,
}

impl Portal for Arc<Fake> {
    async fn set_selection(&self, mime_types: &[&str]) -> Result<()> {
        if self.refuse_set {
            bail!(NOT_ALLOWED);
        }
        *self.offered.lock().unwrap() = mime_types.iter().map(|m| (*m).to_owned()).collect();
        Ok(())
    }
    async fn selection_write(&self, _serial: u32) -> Result<OwnedFd> {
        let (reader, writer) = std::io::pipe()?;
        *self.pasted.lock().unwrap() = Some(reader);
        Ok(writer.into())
    }
    async fn selection_write_done(&self, serial: u32, success: bool) -> Result<()> {
        self.done.lock().unwrap().push((serial, success));
        Ok(())
    }
    async fn selection_read(&self, mime_type: &str) -> Result<OwnedFd> {
        self.reads.lock().unwrap().push(mime_type.to_owned());
        let held = self.held.get(mime_type).cloned().unwrap_or(Held::Refused);
        let (reader, writer) = std::io::pipe()?;
        match held {
            Held::Bytes(bytes) => {
                std::thread::spawn(move || {
                    let mut writer = writer;
                    let _ = std::io::Write::write_all(&mut writer, &bytes);
                });
            }
            Held::Stuck => self.stuck.lock().unwrap().push(writer),
            Held::Refused => bail!("No such type"),
        }
        Ok(reader.into())
    }
}

fn holding(entries: &[(&str, Held)]) -> Arc<Fake> {
    Arc::new(Fake {
        held: entries
            .iter()
            .map(|(mime, held)| ((*mime).to_owned(), held.clone()))
            .collect(),
        ..Fake::default()
    })
}

fn others(types: &[&str]) -> Vec<String> {
    types.iter().map(|t| (*t).to_owned()).collect()
}

/// C13: an answer reaches the call with its id; a late answer, for a call
/// that gave up, is dropped; a gone helper fails waiting and later calls.
#[test]
fn c13_replies_route_by_id_and_end_with_the_helper() {
    let replies = Arc::new(Replies::default());
    let sent = Arc::new(Mutex::new(Vec::new()));
    let answer = Arc::clone(&replies);
    let log = Arc::clone(&sent);
    let reply = replies
        .ask(Duration::from_secs(5), move |id| {
            log.lock().unwrap().push(id);
            // A stale id first, then the real one, from another thread.
            std::thread::spawn(move || {
                answer.deliver(id + 100, Reply::Text("stale".into()));
                answer.deliver(id, Reply::Text("fresh".into()));
            });
            Ok(())
        })
        .unwrap();
    assert_eq!(reply, Reply::Text("fresh".into()));

    let started = Instant::now();
    let late = replies.ask(Duration::from_millis(50), |_| Ok(()));
    assert!(late.unwrap_err().0.contains("did not answer"));
    assert!(started.elapsed() < Duration::from_secs(2));
    // The late answer finds nobody waiting and is dropped.
    let late_id = sent.lock().unwrap()[0] + 1;
    replies.deliver(late_id, Reply::Set);

    let refused = replies.ask(Duration::from_secs(5), |_| {
        Err(InputError("queue busy".into()))
    });
    assert_eq!(refused.unwrap_err().0, "queue busy");

    let closing = Arc::clone(&replies);
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(20));
        closing.close();
    });
    let started = Instant::now();
    let gone = replies.ask(Duration::from_secs(5), |_| Ok(()));
    assert!(gone.unwrap_err().0.contains("helper has stopped"));
    assert!(started.elapsed() < Duration::from_secs(2));
    let mut called = false;
    let after = replies.ask(Duration::from_secs(5), |_| {
        called = true;
        Ok(())
    });
    assert!(after.is_err());
    assert!(!called, "nothing is sent once the helper has gone");
}

/// C14: a pull asks for the best text type the owner offers, spelt as the
/// owner spelt it; a selection with no text reads as empty.
#[test]
fn c14_pull_picks_the_best_text_type() {
    assert_eq!(
        text_types(&others(&[
            "image/png",
            "UTF8_STRING",
            "text/plain",
            "text/plain;charset=UTF-8"
        ])),
        others(&["text/plain;charset=UTF-8", "text/plain", "UTF8_STRING"])
    );
    assert!(text_types(&others(&["image/png", "text/uri-list"])).is_empty());

    let fake = holding(&[
        (
            "text/plain;charset=UTF-8",
            Held::Bytes("Grüße".as_bytes().into()),
        ),
        ("text/plain", Held::Bytes(b"wrong".to_vec())),
    ]);
    let clipboard = PortalClipboard::new(Arc::clone(&fake));
    clipboard.owner_changed(
        Some(false),
        others(&["text/plain", "text/plain;charset=UTF-8"]),
    );
    assert_eq!(run(clipboard.read()).unwrap(), "Grüße");
    assert_eq!(
        *fake.reads.lock().unwrap(),
        others(&["text/plain;charset=UTF-8"])
    );

    // Not heard who owns it: tries each wanted type until one answers.
    let fake = holding(&[("UTF8_STRING", Held::Bytes(b"legacy".to_vec()))]);
    let clipboard = PortalClipboard::new(Arc::clone(&fake));
    assert_eq!(run(clipboard.read()).unwrap(), "legacy");
    assert_eq!(*fake.reads.lock().unwrap(), others(&WANTED));

    let fake = holding(&[]);
    let clipboard = PortalClipboard::new(Arc::clone(&fake));
    clipboard.owner_changed(None, others(&["image/png"]));
    assert_eq!(run(clipboard.read()).unwrap(), "");
    assert!(fake.reads.lock().unwrap().is_empty());

    // Nothing answers at all: the portal's reason, not an empty clipboard.
    let clipboard = PortalClipboard::new(holding(&[]));
    assert!(run(clipboard.read()).is_err());
}

/// C15: a push offers UTF-8 text types and writes the text to a program
/// that pastes it; a type not offered, or a push another program has
/// replaced, is refused; a pull while the push is ours reads it back.
#[test]
fn c15_push_answers_transfers_until_another_program_takes_over() {
    let fake = holding(&[]);
    let clipboard = PortalClipboard::new(Arc::clone(&fake));
    run(clipboard.set("Grüße, world".into())).unwrap();
    assert_eq!(*fake.offered.lock().unwrap(), others(&OFFERED));
    assert_eq!(run(clipboard.read()).unwrap(), "Grüße, world");

    run(clipboard.transfer("text/plain;charset=utf-8", 7)).unwrap();
    let mut pasted = String::new();
    fake.pasted
        .lock()
        .unwrap()
        .take()
        .unwrap()
        .read_to_string(&mut pasted)
        .unwrap();
    assert_eq!(pasted, "Grüße, world");

    assert!(run(clipboard.transfer("image/png", 8)).is_err());

    // The portal confirms the push, then another program copies.
    clipboard.owner_changed(Some(true), others(&OFFERED));
    clipboard.owner_changed(Some(false), others(&["text/plain"]));
    assert!(run(clipboard.transfer("text/plain", 9)).is_err());
    assert_eq!(
        *fake.done.lock().unwrap(),
        [(7, true), (8, false), (9, false)]
    );

    let refusing = Arc::new(Fake {
        refuse_set: true,
        ..Fake::default()
    });
    let clipboard = PortalClipboard::new(Arc::clone(&refusing));
    let error = run(clipboard.set("secret".into())).unwrap_err();
    assert_eq!(error.to_string(), NOT_ALLOWED);
    assert!(
        run(clipboard.transfer("text/plain", 1)).is_err(),
        "a refused push keeps nothing"
    );
}

/// C16: a pull over 1 MiB fails as too large; exactly 1 MiB reads whole.
#[test]
fn c16_pull_is_capped_at_one_mebibyte() {
    let exact = "a".repeat(MAX_CLIPBOARD_BYTES);
    let clipboard = PortalClipboard::new(holding(&[(
        "text/plain;charset=utf-8",
        Held::Bytes(exact.clone().into_bytes()),
    )]));
    assert_eq!(run(clipboard.read()).unwrap().len(), exact.len());

    let clipboard = PortalClipboard::new(holding(&[(
        "text/plain;charset=utf-8",
        Held::Bytes(vec![b'a'; MAX_CLIPBOARD_BYTES + 1]),
    )]));
    let error = run(clipboard.read()).unwrap_err().to_string();
    assert_eq!(error, bmuster_desktop::clipboard::too_large().0);

    assert!(
        run(PortalClipboard::new(holding(&[])).set("a".repeat(MAX_CLIPBOARD_BYTES + 1))).is_err()
    );
}

/// C17: an owner that never finishes writing fails the pull after the
/// clipboard wait, with a reason, instead of holding the helper.
#[test]
fn c17_pull_from_a_stuck_owner_times_out() {
    let clipboard = PortalClipboard::new(holding(&[("text/plain;charset=utf-8", Held::Stuck)]));
    let started = Instant::now();
    let error = run(clipboard.read()).unwrap_err().to_string();
    assert!(error.contains("did not answer"), "{error}");
    assert!(started.elapsed() >= CLIPBOARD_WAIT);
    assert!(
        started.elapsed() < AGENT_WAIT,
        "the helper answers before the agent gives up"
    );
}
