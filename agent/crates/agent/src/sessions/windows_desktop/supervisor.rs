//! The service's side of Windows desktop sessions (SPEC-DESKTOP 6.2).
//!
//! One helper runs per console session and carries every open desktop
//! session (so the notice bar lists every viewer and the four-session limit
//! holds). A watcher thread polls the console session twice a second and
//! follows [`follow::decide`]: it starts a helper for the first session,
//! moves the sessions to a new helper when the console session changes
//! (fast user switching, signing out), restarts a helper that died, and
//! stops the helper when the last session ends.
//!
//! A move keeps the browser's session: the new helper opens the same
//! session socket, the server hands the session over to it and closes the
//! old helper's socket, and the browser greets the new helper (`hello`),
//! which answers with `displays`, `state` and a keyframe. The old helper is
//! told to quit once the new one holds every session, and is ended after 20
//! seconds whatever happens. A helper that dies on its own (its session was
//! signed out) leaves the server waiting up to 15 seconds for the new one.

use super::sas;
use bmuster_desktop::winsession::command_line::quote;
use bmuster_desktop::winsession::follow::{self, Action, HelperView, RestartBudget};
use bmuster_desktop::winsession::handoff::{read_message, write_message, FromHelper, ToHelper};
use bmuster_desktop::winsession::launch::{self, Job, Process};
use bmuster_desktop::winsession::{console, pipe};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(500);
const PIPE_TIMEOUT: Duration = Duration::from_secs(15);
/// An old helper is ended this long after a move, whether or not it quit.
const RETIRE_WITHIN: Duration = Duration::from_secs(20);
/// After `quit`, a helper has this long to end its sessions and exit.
const QUIT_WITHIN: Duration = Duration::from_secs(5);

/// How a desktop session ended, as the service's session thread hears it.
pub enum Outcome {
    /// The helper ran it and it ended; the reason is for the log.
    Ended(String),
    /// It never ran; the message is for the console.
    Failed(String),
}

/// What the helper needs to know about this agent, set once by the worker.
pub struct Options {
    pub data_dir: PathBuf,
    pub insecure_dev_tls: bool,
}

static OPTIONS: OnceLock<Options> = OnceLock::new();
static SUPERVISOR: OnceLock<Result<Supervisor, String>> = OnceLock::new();

/// Called by the worker when it starts.
pub fn configure(options: Options) {
    if OPTIONS.set(options).is_err() {
        log::warn!("The desktop helper was configured twice");
    }
}

/// The supervisor, made on first use.
pub fn supervisor() -> Result<&'static Supervisor, String> {
    SUPERVISOR
        .get_or_init(|| {
            let options = OPTIONS
                .get()
                .ok_or("the desktop helper is not configured")?;
            Ok(Supervisor {
                state: Mutex::new(State::default()),
                job: Job::new().map_err(|e| format!("cannot make the helpers' Job Object: {e}"))?,
                data_dir: options.data_dir.clone(),
                insecure_dev_tls: options.insecure_dev_tls,
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// One open desktop session.
struct Live {
    ticket: String,
    signature: String,
    admitted_at_ms: i64,
    clock_offset_ms: i64,
    /// Sent to a helper before (a later start is a hand-over).
    started: bool,
    done: Sender<Outcome>,
}

struct Helper {
    id: u64,
    console_session: u32,
    process: Arc<Process>,
    writer: Arc<Mutex<File>>,
    /// Sessions whose socket this helper has open.
    attached: HashSet<String>,
}

impl Helper {
    fn send(&self, message: &ToHelper) {
        let mut writer = self
            .writer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Err(error) = write_message(&mut *writer, message) {
            log::warn!("Could not write to desktop helper {}: {error}", self.id);
        }
    }
}

struct Retiring {
    helper: Helper,
    quit_sent: bool,
    kill_at: Instant,
}

#[derive(Default)]
struct State {
    sessions: HashMap<String, Live>,
    helper: Option<Helper>,
    retiring: Vec<Retiring>,
    budget: RestartBudget,
    watching: bool,
    next_id: u64,
}

pub struct Supervisor {
    state: Mutex<State>,
    /// Ends every helper when the agent's process ends, however it ends.
    job: Job,
    data_dir: PathBuf,
    insecure_dev_tls: bool,
}

fn start_message(session_id: &str, live: &Live, resume: bool) -> ToHelper {
    ToHelper::Start {
        session_id: session_id.to_string(),
        ticket: live.ticket.clone(),
        signature: live.signature.clone(),
        admitted_at_ms: live.admitted_at_ms,
        clock_offset_ms: live.clock_offset_ms,
        resume,
    }
}

impl Supervisor {
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Runs one desktop session through the helper and waits for it to end
    /// (or for `stop`, the agent stopping).
    pub fn run_session(
        &'static self,
        session_id: &str,
        ticket: &str,
        signature: &str,
        admitted_at_ms: i64,
        clock_offset_ms: i64,
        stop: &AtomicBool,
    ) -> Outcome {
        let (done, outcome) = mpsc::channel();
        {
            let mut state = self.lock();
            let mut live = Live {
                ticket: ticket.to_string(),
                signature: signature.to_string(),
                admitted_at_ms,
                clock_offset_ms,
                started: false,
                done,
            };
            if let Some(helper) = &state.helper {
                helper.send(&start_message(session_id, &live, false));
                live.started = true;
            }
            state.sessions.insert(session_id.to_string(), live);
            if !state.watching {
                state.watching = true;
                let started = std::thread::Builder::new()
                    .name("desktop-watch".into())
                    .spawn(move || self.watch());
                if let Err(error) = started {
                    state.watching = false;
                    state.sessions.remove(session_id);
                    return Outcome::Failed(format!(
                        "The agent could not watch the console session: {error}"
                    ));
                }
            }
        }
        loop {
            match outcome.recv_timeout(Duration::from_millis(250)) {
                Ok(result) => return result,
                Err(RecvTimeoutError::Disconnected) => {
                    return Outcome::Ended("the supervisor let go".into())
                }
                Err(RecvTimeoutError::Timeout) if stop.load(Ordering::SeqCst) => {
                    if let Some(helper) = &self.lock().helper {
                        helper.send(&ToHelper::Stop {
                            session_id: session_id.to_string(),
                        });
                    }
                    let result = outcome
                        .recv_timeout(Duration::from_secs(3))
                        .unwrap_or_else(|_| Outcome::Ended("the agent stopped".into()));
                    self.lock().sessions.remove(session_id);
                    return result;
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
        }
    }

    /// Ends every open session with `message` (the helper cannot run).
    fn fail_all(state: &mut State, message: &str) {
        log::error!("Desktop sessions failed: {message}");
        for (_, live) in state.sessions.drain() {
            let _ = live.done.send(Outcome::Failed(message.to_string()));
        }
    }

    fn watch(&'static self) {
        loop {
            let action = {
                let mut state = self.lock();
                self.tend_retiring(&mut state);
                let view = state.helper.as_ref().map(|helper| HelperView {
                    console_session: helper.console_session,
                    running: helper.process.running(),
                });
                let action = follow::decide(
                    view,
                    console::active_console_session(),
                    state.sessions.len(),
                );
                if action == Action::Nothing
                    && state.sessions.is_empty()
                    && state.helper.is_none()
                    && state.retiring.is_empty()
                {
                    state.watching = false;
                    return;
                }
                if let Action::Restart { .. } = action {
                    let code = state
                        .helper
                        .as_ref()
                        .and_then(|helper| helper.process.exit_code());
                    log::warn!("The desktop helper exited (code {code:?}) with sessions open");
                    state.helper = None;
                    if !state.budget.allow(Instant::now()) {
                        Self::fail_all(
                            &mut state,
                            "The desktop helper keeps stopping on this machine; desktop-helper.log in the agent's data folder says why.",
                        );
                        continue;
                    }
                }
                if action == Action::Stop {
                    if let Some(helper) = state.helper.take() {
                        helper.send(&ToHelper::Quit);
                        state.retiring.push(Retiring {
                            helper,
                            quit_sent: true,
                            kill_at: Instant::now() + QUIT_WITHIN,
                        });
                    }
                }
                action
            };
            match action {
                Action::Start { console_session }
                | Action::Restart { console_session }
                | Action::Move {
                    to: console_session,
                    ..
                } => self.replace_helper(console_session),
                Action::Stop | Action::Nothing => {}
            }
            std::thread::sleep(POLL);
        }
    }

    /// Starts a helper in `console_session` and gives it every open
    /// session; the helper it replaces (if any) retires.
    fn replace_helper(&'static self, console_session: u32) {
        log::info!("Starting the desktop helper in console session {console_session}");
        let id = {
            let mut state = self.lock();
            state.next_id += 1;
            state.next_id
        };
        let started = self.start_helper(id, console_session);
        let mut state = self.lock();
        match started {
            Ok(helper) => {
                if let Some(old) = state.helper.take() {
                    state.retiring.push(Retiring {
                        helper: old,
                        quit_sent: false,
                        kill_at: Instant::now() + RETIRE_WITHIN,
                    });
                }
                for (session_id, live) in state.sessions.iter_mut() {
                    helper.send(&start_message(session_id, live, live.started));
                    live.started = true;
                }
                state.helper = Some(helper);
            }
            Err(error) => {
                log::error!("Could not start the desktop helper: {error}");
                if !state.budget.allow(Instant::now()) {
                    Self::fail_all(
                        &mut state,
                        &format!("The agent could not start its desktop helper: {error}"),
                    );
                }
            }
        }
    }

    fn start_helper(&'static self, id: u64, console_session: u32) -> Result<Helper, String> {
        let listener = pipe::Listener::create(pipe::SYSTEM_ONLY)?;
        let program =
            std::env::current_exe().map_err(|e| format!("cannot find this program's path: {e}"))?;
        let mut line = format!(
            "{} desktop-helper --pipe {} --service-pid {} --data-dir {}",
            quote(&program.to_string_lossy()),
            quote(listener.name()),
            std::process::id(),
            quote(&self.data_dir.to_string_lossy()),
        );
        if self.insecure_dev_tls {
            line.push_str(" --insecure-dev-tls");
        }
        let process = Arc::new(launch::start_in_session(console_session, &line, &self.job)?);
        let end = match listener.accept(Some(process.id), PIPE_TIMEOUT, || process.running()) {
            Ok(end) => end,
            Err(error) => {
                process.kill();
                return Err(error);
            }
        };
        let reader = end.reader;
        std::thread::Builder::new()
            .name(format!("desktop-helper-{id}"))
            .spawn(move || self.read(id, reader))
            .map_err(|e| format!("cannot start the helper's reader: {e}"))?;
        Ok(Helper {
            id,
            console_session,
            process,
            writer: Arc::new(Mutex::new(end.writer)),
            attached: HashSet::new(),
        })
    }

    /// Quits old helpers once the new one holds every session, and ends
    /// any that outstay their time.
    fn tend_retiring(&self, state: &mut State) {
        let now = Instant::now();
        let handed_over = state.helper.as_ref().is_some_and(|helper| {
            state
                .sessions
                .keys()
                .all(|session| helper.attached.contains(session))
        });
        state.retiring.retain_mut(|old| {
            if !old.helper.process.running() {
                return false;
            }
            if now >= old.kill_at {
                log::warn!("Ending desktop helper {}: it did not quit", old.helper.id);
                old.helper.process.kill();
                return false;
            }
            if !old.quit_sent && handed_over {
                old.helper.send(&ToHelper::Quit);
                old.quit_sent = true;
                old.kill_at = old.kill_at.min(now + QUIT_WITHIN);
            }
            true
        });
    }

    fn read(&'static self, id: u64, mut reader: File) {
        loop {
            match read_message::<FromHelper>(&mut reader) {
                Ok(Some(message)) => self.on_message(id, message),
                Ok(None) => break,
                Err(error) => {
                    log::warn!("Desktop helper {id} sent something unreadable: {error}");
                    break;
                }
            }
        }
        log::info!("Desktop helper {id} closed its pipe");
    }

    fn on_message(&'static self, id: u64, message: FromHelper) {
        let mut state = self.lock();
        let current = state.helper.as_ref().is_some_and(|helper| helper.id == id);
        match message {
            FromHelper::Hello {
                process_id,
                console_session,
            } => log::info!(
                "Desktop helper {id} is up: process {process_id}, console session {console_session}"
            ),
            FromHelper::Attached { session_id } => {
                if let Some(helper) = state.helper.as_mut().filter(|_| current) {
                    helper.attached.insert(session_id);
                }
            }
            FromHelper::Ended { session_id, reason } if current => {
                if let Some(live) = state.sessions.remove(&session_id) {
                    let _ = live.done.send(Outcome::Ended(reason));
                }
            }
            FromHelper::Failed {
                session_id,
                message,
            } if current => {
                if let Some(live) = state.sessions.remove(&session_id) {
                    let _ = live.done.send(Outcome::Failed(message));
                }
            }
            FromHelper::Ended { session_id, .. } | FromHelper::Failed { session_id, .. } => {
                log::info!("Desktop session {session_id} left old helper {id}");
            }
            FromHelper::SecureAttention if current => {
                drop(state);
                let data_dir = self.data_dir.clone();
                // Off the reader: setting the policy and SendSAS may take a moment.
                let sent = std::thread::Builder::new()
                    .name("desktop-sas".into())
                    .spawn(move || match sas::send(&data_dir) {
                        Ok(()) => log::info!("Sent Ctrl+Alt+Del to the console"),
                        Err(error) => log::error!("Could not send Ctrl+Alt+Del: {error}"),
                    });
                if let Err(error) = sent {
                    log::error!("Could not send Ctrl+Alt+Del: {error}");
                }
            }
            FromHelper::SecureAttention => {
                log::warn!("Ignored Ctrl+Alt+Del from old desktop helper {id}");
            }
        }
    }
}
