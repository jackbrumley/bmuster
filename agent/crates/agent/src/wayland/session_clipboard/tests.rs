use super::routes::{decode, read_within, text_type, Backend, Backends, Failure};
use super::*;
use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::time::{Instant, SystemTime};

/// A route that answers as told and remembers the text it was given.
struct Fake {
    name: &'static str,
    answer: Result<(), Failure>,
    held: Arc<Mutex<Vec<String>>>,
}

impl Backend for Fake {
    fn name(&self) -> &'static str {
        self.name
    }
    fn set(&mut self, text: &str) -> Result<(), Failure> {
        self.answer.clone()?;
        self.held.lock().unwrap().push(text.to_string());
        Ok(())
    }
    fn get(&mut self) -> Result<String, Failure> {
        self.answer.clone()?;
        Ok(self
            .held
            .lock()
            .unwrap()
            .last()
            .cloned()
            .unwrap_or_default())
    }
}

fn fake(
    name: &'static str,
    answer: Result<(), Failure>,
) -> (Box<dyn Backend>, Arc<Mutex<Vec<String>>>) {
    let held = Arc::new(Mutex::new(Vec::new()));
    let route = Fake {
        name,
        answer,
        held: Arc::clone(&held),
    };
    (Box::new(route), held)
}

fn unsupported(reason: &str) -> Result<(), Failure> {
    Err(Failure::Unsupported(reason.into()))
}

/// SPEC-DESKTOP C21: the first route the desktop supports serves the call
/// (data-control before XWayland); a route that is there but fails answers
/// with its reason and the next is not tried; with none supported the
/// answer names each route's reason. The route is reported once per change.
#[test]
fn c21_backend_selection_takes_the_first_supported_route() {
    let (data_control, wayland_held) = fake("data-control", Ok(()));
    let (x11, x11_held) = fake("x11", Ok(()));
    let mut both = Backends::new(vec![data_control, x11]);
    both.set("hello").unwrap();
    assert_eq!(both.changed(), Some("data-control"));
    assert_eq!(both.get().unwrap(), "hello");
    assert_eq!(both.changed(), None, "reported once");
    assert_eq!(*wayland_held.lock().unwrap(), ["hello"]);
    assert!(x11_held.lock().unwrap().is_empty());

    // GNOME: no data-control, so XWayland's selection serves.
    let (data_control, _) = fake("data-control", unsupported("no ext-data-control"));
    let (x11, x11_held) = fake("x11", Ok(()));
    let mut gnome = Backends::new(vec![data_control, x11]);
    gnome.set("grüße").unwrap();
    assert_eq!(gnome.changed(), Some("x11"));
    assert_eq!(*x11_held.lock().unwrap(), ["grüße"]);

    // A route that fails is the answer.
    let (data_control, _) = fake("data-control", Err(Failure::Failed("stuck".into())));
    let (x11, x11_held) = fake("x11", Ok(()));
    let mut failing = Backends::new(vec![data_control, x11]);
    assert_eq!(failing.set("x").unwrap_err(), "stuck");
    assert!(x11_held.lock().unwrap().is_empty());

    // Nothing at all: an honest reason naming each route.
    let (data_control, _) = fake("data-control", unsupported("no protocol"));
    let (x11, _) = fake("x11", unsupported("no X display"));
    let mut none = Backends::new(vec![data_control, x11]);
    let reason = none.get().unwrap_err();
    assert!(
        reason.starts_with("Copy and paste is not available on this desktop"),
        "{reason}"
    );
    assert!(reason.contains("data-control: no protocol"), "{reason}");
    assert!(reason.contains("x11: no X display"), "{reason}");
    assert_eq!(none.changed(), None);

    // Over 1 MiB is refused before any route.
    let (data_control, held) = fake("data-control", Ok(()));
    let mut capped = Backends::new(vec![data_control]);
    let large = "x".repeat(bmuster_desktop::control::MAX_CLIPBOARD_BYTES + 1);
    assert!(capped.set(&large).is_err());
    assert!(held.lock().unwrap().is_empty());
}

/// SPEC-DESKTOP C22: a pull asks for the best text type on offer
/// (UTF-8 first, then plain text, Latin-1 `STRING`, `TEXT`), matching
/// without regard to case; nothing that is text reads as empty; `STRING`
/// is decoded as Latin-1.
#[test]
fn c22_pull_picks_the_best_text_type() {
    let offered = |types: &[&str]| types.iter().map(|t| t.to_string()).collect::<Vec<_>>();
    assert_eq!(
        text_type(&offered(&[
            "text/html",
            "STRING",
            "TEXT/PLAIN;CHARSET=UTF-8",
            "UTF8_STRING"
        ]))
        .map(String::as_str),
        Some("TEXT/PLAIN;CHARSET=UTF-8")
    );
    assert_eq!(
        text_type(&offered(&["text/plain", "UTF8_STRING"])).map(String::as_str),
        Some("UTF8_STRING")
    );
    assert_eq!(
        text_type(&offered(&["TEXT", "STRING", "text/html"])).map(String::as_str),
        Some("STRING")
    );
    assert_eq!(text_type(&offered(&["image/png", "text/html"])), None);
    assert_eq!(decode("STRING", &[0x47, 0x72, 0xfc, 0xdf, 0x65]), "Grüße");
    assert_eq!(decode("UTF8_STRING", "Grüße".as_bytes()), "Grüße");
    assert_eq!(decode("text/plain", &[0x61, 0xff]), "a\u{fffd}");
}

fn pipe() -> (OwnedFd, std::fs::File) {
    let mut fds = [0; 2];
    // SAFETY: pipe fills two descriptors that are then owned here.
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    use std::os::fd::FromRawFd as _;
    // SAFETY: both descriptors were just made and are owned once each.
    unsafe {
        (
            OwnedFd::from_raw_fd(fds[0]),
            std::fs::File::from_raw_fd(fds[1]),
        )
    }
}

/// SPEC-DESKTOP C23: a pull reads exactly 1 MiB whole, fails past it with
/// "more than 1 MB", and fails after the wait when the owner never
/// finishes writing.
#[test]
fn c23_pull_is_capped_and_times_out() {
    use std::io::Write as _;
    let cap = bmuster_desktop::control::MAX_CLIPBOARD_BYTES;
    for (size, fits) in [(cap, true), (cap + 1, false)] {
        let (read, mut write) = pipe();
        let writer = std::thread::spawn(move || {
            let _ = write.write_all(&vec![b'a'; size]);
        });
        let result = read_within(read, cap, Duration::from_secs(5));
        writer.join().unwrap();
        match result {
            Ok(bytes) => assert!(fits && bytes.len() == size),
            Err(reason) => assert!(!fits && reason.contains("more than 1 MB"), "{reason}"),
        }
    }
    let (read, mut write) = pipe();
    write.write_all(b"partial").unwrap();
    let started = Instant::now();
    let reason = read_within(read, cap, Duration::from_millis(300)).unwrap_err();
    assert!(reason.contains("did not answer"), "{reason}");
    assert!(started.elapsed() < Duration::from_secs(2));
    drop(write);
}

/// SPEC-DESKTOP C24: the session's X display and Xauthority come from the
/// user manager's environment, else the newest compositor-made Xauthority;
/// no `DISPLAY` means no XWayland route.
#[test]
fn c24_xwayland_display_comes_from_the_session_environment() {
    use super::xwayland::{parse_environment, target};
    let environment = parse_environment(
        "DISPLAY=:0\nXAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.ABC123\nWAYLAND_DISPLAY=wayland-0\nODD=$'a b'\n",
    );
    assert_eq!(environment.get("WAYLAND_DISPLAY").unwrap(), "wayland-0");
    assert!(!environment.contains_key("ODD"));
    let found = |name: &str, age: u64| {
        (
            PathBuf::from(format!("/run/user/1000/{name}")),
            SystemTime::UNIX_EPOCH + Duration::from_secs(age),
        )
    };
    let named = target(&environment, &[found("xauth_old", 1)]).unwrap();
    assert_eq!(named.display, ":0");
    assert_eq!(
        named.xauthority,
        Some(PathBuf::from("/run/user/1000/.mutter-Xwaylandauth.ABC123"))
    );
    let plasma = parse_environment("DISPLAY=:1\n");
    let newest = target(&plasma, &[found("xauth_old", 1), found("xauth_new", 2)]).unwrap();
    assert_eq!(
        newest.xauthority,
        Some(PathBuf::from("/run/user/1000/xauth_new"))
    );
    assert!(target(&parse_environment("WAYLAND_DISPLAY=wayland-0\n"), &[]).is_err());

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join(".mutter-Xwaylandauth.Q1"), b"").unwrap();
    std::fs::write(dir.path().join("xauth_abc"), b"").unwrap();
    std::fs::write(dir.path().join("pulse"), b"").unwrap();
    let mut files = super::xwayland::xauthority_files(dir.path())
        .into_iter()
        .map(|(path, _)| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    files.sort();
    assert_eq!(files, [".mutter-Xwaylandauth.Q1", "xauth_abc"]);
}

/// The helper's serve loop on one end of a socket pair, with a fake route.
fn helper_on(stream: UnixStream, answer: Result<(), Failure>) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let (route, _) = fake("fake route", answer);
        let mut backends = Backends::new(vec![route]);
        let input = BufReader::new(stream.try_clone().unwrap());
        helper::serve(input, &Mutex::new(stream), &mut backends).unwrap();
    })
}

/// SPEC-DESKTOP C25: the agent's calls reach the person's helper and come
/// back by id (push, then pull of the same text); a failure carries the
/// route's reason; closing the agent's end ends the helper.
#[test]
fn c25_calls_route_to_the_helper_and_back() {
    let (agent, user) = UnixStream::pair().unwrap();
    let serving = helper_on(user, Ok(()));
    let helper = UserHelper::over(1000, agent, Duration::from_secs(5), Box::new(())).unwrap();
    let pushed = helper
        .ask(|id| Command::ClipboardSet {
            id,
            text: "Grüße".into(),
        })
        .unwrap();
    assert_eq!(pushed, Reply::Set);
    assert_eq!(
        helper.ask(|id| Command::ClipboardGet { id }).unwrap(),
        Reply::Text("Grüße".into())
    );
    assert_eq!(*helper.backend.lock().unwrap(), "fake route");
    drop(helper);
    serving.join().unwrap();

    let (agent, user) = UnixStream::pair().unwrap();
    let serving = helper_on(user, Err(Failure::Failed("the owner went away".into())));
    let helper = UserHelper::over(1000, agent, Duration::from_secs(5), Box::new(())).unwrap();
    assert_eq!(
        helper.ask(|id| Command::ClipboardGet { id }).unwrap(),
        Reply::Failed("the owner went away".into())
    );
    drop(helper);
    serving.join().unwrap();
}

/// SPEC-DESKTOP C26: a helper that never answers fails the call after the
/// wait, and its late answer is dropped; a helper that has gone fails the
/// call at once and the next call starts a new one.
#[test]
fn c26_silent_or_gone_helper_fails_and_is_replaced() {
    let (agent, user) = UnixStream::pair().unwrap();
    let helper = UserHelper::over(1000, agent, Duration::from_millis(200), Box::new(())).unwrap();
    let error = helper.ask(|id| Command::ClipboardGet { id }).unwrap_err();
    assert!(error.0.contains("did not answer"), "{error:?}");
    // The late answer for call 1 goes nowhere; call 2 gets its own.
    let mut late = user.try_clone().unwrap();
    wire::json(
        &mut late,
        &Event::ClipboardText {
            id: 1,
            text: "late".into(),
        },
    )
    .unwrap();
    wire::json(&mut late, &Event::ClipboardSet { id: 2 }).unwrap();
    assert_eq!(
        helper
            .ask(|id| Command::ClipboardSet {
                id,
                text: "x".into()
            })
            .unwrap(),
        Reply::Set
    );
    drop(user);
    drop(late);
    let started = Instant::now();
    while !helper.replies.is_closed() && started.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(helper.ask(|id| Command::ClipboardGet { id }).is_err());

    // KmsClipboard starts a fresh helper for the next call.
    let starts = Arc::new(Mutex::new(0));
    let counted = Arc::clone(&starts);
    let mut clipboard = KmsClipboard::with(
        "2",
        Box::new(|_| Ok(unlocked(1000))),
        Box::new(move |uid| {
            *counted.lock().unwrap() += 1;
            let (agent, user) = UnixStream::pair().unwrap();
            helper_on(user, Ok(()));
            UserHelper::over(uid, agent, Duration::from_secs(5), Box::new(()))
        }),
    );
    clipboard.helper = Some(helper);
    clipboard.set("again").unwrap();
    assert_eq!(clipboard.get().unwrap(), "again");
    assert_eq!(*starts.lock().unwrap(), 1);
}

fn unlocked(uid: u32) -> HashMap<String, String> {
    [
        ("Type", "wayland"),
        ("Class", "user"),
        ("State", "active"),
        ("LockedHint", "no"),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), value.to_string()))
    .chain([("User".to_string(), uid.to_string())])
    .collect()
}

/// SPEC-DESKTOP C20 (the agent's side): while the session is locked, at
/// the sign-in screen or with no session, a call is refused with the
/// reason and no helper is started; the helper is started once the
/// session is unlocked and replaced when another person's session is on
/// the screen.
#[test]
fn c20_locked_session_is_refused_before_any_helper_starts() {
    let properties = Arc::new(Mutex::new(unlocked(1000)));
    properties
        .lock()
        .unwrap()
        .insert("LockedHint".into(), "yes".into());
    let starts = Arc::new(Mutex::new(Vec::new()));
    let (seen, started) = (Arc::clone(&properties), Arc::clone(&starts));
    let mut clipboard = KmsClipboard::with(
        "2",
        Box::new(move |_| Ok(seen.lock().unwrap().clone())),
        Box::new(move |uid| {
            started.lock().unwrap().push(uid);
            let (agent, user) = UnixStream::pair().unwrap();
            helper_on(user, Ok(()));
            UserHelper::over(uid, agent, Duration::from_secs(5), Box::new(()))
        }),
    );
    for call in [
        clipboard.set("secret").unwrap_err(),
        clipboard.get().unwrap_err(),
    ] {
        assert_eq!(call.0, bmuster_desktop::clipboard::LOCKED);
    }
    assert!(starts.lock().unwrap().is_empty());
    *properties.lock().unwrap() = unlocked(1000);
    clipboard.set("hello").unwrap();
    *properties.lock().unwrap() = unlocked(1001);
    assert_eq!(clipboard.get().unwrap(), "");
    assert_eq!(*starts.lock().unwrap(), [1000, 1001]);

    let mut nobody = KmsClipboard::with(
        "none",
        Box::new(|_| panic!("no session to read")),
        Box::new(|_| panic!("no helper without a session")),
    );
    assert_eq!(
        nobody.get().unwrap_err().0,
        bmuster_desktop::clipboard::not_available().0
    );
}

/// SPEC-DESKTOP C27 (protocol level, run by hand against a real
/// compositor with data-control: `BMUSTER_WAYLAND_TESTS=data-control
/// WAYLAND_DISPLAY=wayland-0 cargo test -p bmuster-agent c27`): a push is
/// read back through the compositor, ASCII, non-ASCII and 1 MiB.
#[test]
fn c27_data_control_round_trips_through_the_compositor() {
    if std::env::var("BMUSTER_WAYLAND_TESTS").as_deref() != Ok("data-control") {
        return;
    }
    let mut route = super::data_control::DataControl;
    for text in [
        "hello".to_string(),
        "Grüße, BMuster €".to_string(),
        "z".repeat(bmuster_desktop::control::MAX_CLIPBOARD_BYTES),
    ] {
        route.set(&text).unwrap();
        // Give the compositor a moment to hand the selection over.
        std::thread::sleep(Duration::from_millis(100));
        assert_eq!(route.get().unwrap(), text);
    }
}

/// SPEC-DESKTOP C32: on a KMS screen, clipboard sharing starts the
/// person's helper, and each change its watch tells of is reported once;
/// while the session is locked no change is reported and none is kept for
/// later.
#[test]
fn c32_kms_sharing_reports_the_helpers_changes_once_and_none_while_locked() {
    let properties = Arc::new(Mutex::new(unlocked(1000)));
    let users = Arc::new(Mutex::new(Vec::new()));
    let (seen, helpers) = (Arc::clone(&properties), Arc::clone(&users));
    let mut clipboard = KmsClipboard::with(
        "2",
        Box::new(move |_| Ok(seen.lock().unwrap().clone())),
        Box::new(move |uid| {
            let (agent, user) = UnixStream::pair().unwrap();
            helpers.lock().unwrap().push(user);
            UserHelper::over(uid, agent, Duration::from_secs(5), Box::new(()))
        }),
    );
    assert!(!clipboard.changed().unwrap(), "starting is not a change");
    assert_eq!(users.lock().unwrap().len(), 1, "sharing started the helper");
    let tell = |users: &Arc<Mutex<Vec<UnixStream>>>| {
        let mut users = users.lock().unwrap();
        wire::json(&mut users[0], &Event::ClipboardChanged).unwrap();
    };
    let wait_for_change = |clipboard: &mut KmsClipboard| {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(2) {
            if clipboard.changed().unwrap() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    };
    tell(&users);
    assert!(wait_for_change(&mut clipboard));
    assert!(!clipboard.changed().unwrap(), "once");

    properties
        .lock()
        .unwrap()
        .insert("LockedHint".into(), "yes".into());
    clipboard.routed = None;
    tell(&users);
    assert!(!wait_for_change(&mut clipboard), "nothing while locked");
    *properties.lock().unwrap() = unlocked(1000);
    clipboard.routed = None;
    assert!(
        !clipboard.changed().unwrap(),
        "a change seen while locked is not kept"
    );
}
