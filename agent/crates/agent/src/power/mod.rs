//! Stay awake on mains power (SPEC-STAY-AWAKE).
//!
//! - **Policy:** one boolean from the server (`power-policy`), kept in
//!   [`POLICY_FILE`] in the data folder so it applies after a restart before
//!   the server is reachable. Off when the file is missing.
//! - **Keeper:** while the policy is on and the machine is on mains power (or
//!   has no battery), it holds the platform's sleep inhibitor; on battery, or
//!   with the policy off, it lets go at once. Only idle sleep is held off:
//!   lid close, the power button and Sleep or Shut down from the menu still
//!   work, and the screen may still turn off.
//! - **When:** at start, every [`CHECK_EVERY`] and as soon as the policy
//!   changes. The inhibitor is released when the agent stops.
//! - **Report:** the inventory's `power`, so Manage shows what the agent does.
//!   A failure to take the inhibitor is logged and reported, never silent.

#[cfg(target_os = "linux")]
pub mod linux;
// Compiled for tests everywhere: the dedicated thread is plain Rust, only
// the two Win32 calls are Windows code.
#[cfg(any(windows, test))]
pub mod windows;

use bmuster_protocol::power::{Inhibitor, KeepAwake, PowerReport, PowerSource};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// The last policy the server sent, in the data folder.
pub const POLICY_FILE: &str = "power-policy.json";
/// How often the power source is read again.
pub const CHECK_EVERY: Duration = Duration::from_secs(30);

/// What [`POLICY_FILE`] holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedPolicy {
    keep_awake_on_ac: bool,
}

/// The saved policy; off when there is none. A damaged file is logged and
/// read as off, the machine's normal behaviour.
pub fn load_policy(data_dir: &Path) -> bool {
    let path = data_dir.join(POLICY_FILE);
    match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<SavedPolicy>(&bytes) {
            Ok(saved) => saved.keep_awake_on_ac,
            Err(error) => {
                log::warn!(
                    "Stay awake: {} is unreadable ({error}); treating the setting as off until the server sends it.",
                    path.display()
                );
                false
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            log::warn!(
                "Stay awake: could not read {} ({error}); treating the setting as off until the server sends it.",
                path.display()
            );
            false
        }
    }
}

pub fn save_policy(data_dir: &Path, keep_awake_on_ac: bool) -> anyhow::Result<()> {
    let bytes = serde_json::to_vec(&SavedPolicy { keep_awake_on_ac })?;
    crate::identity::write_private(&data_dir.join(POLICY_FILE), &bytes)
}

/// One reading of the power source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reading {
    pub source: PowerSource,
    /// 0 to 100; `None` without a battery or when the system will not say.
    pub battery_percent: Option<u8>,
}

/// A sleep inhibitor: taking it returns a lock, and dropping the lock
/// releases it.
pub trait Inhibit {
    type Lock;
    fn take(&mut self) -> Result<Self::Lock, String>;
}

/// Holds the inhibitor exactly while the policy is on and the machine is on
/// mains power. Pure apart from the inhibitor, so the rule is tested with a
/// fake one.
pub struct Keeper<I: Inhibit> {
    inhibit: I,
    held: Option<I::Lock>,
    /// The last failure, so it is logged once and not every 30 s.
    failure: Option<String>,
}

impl<I: Inhibit> Keeper<I> {
    pub fn new(inhibit: I) -> Self {
        Self {
            inhibit,
            held: None,
            failure: None,
        }
    }

    #[cfg(test)]
    pub fn is_held(&self) -> bool {
        self.held.is_some()
    }

    /// Takes or releases the inhibitor for this policy and reading, and
    /// says what it did.
    pub fn apply(&mut self, keep_awake_on_ac: bool, reading: Reading) -> PowerReport {
        let on_mains = reading.source == PowerSource::Mains;
        let keep_awake = match (keep_awake_on_ac, on_mains) {
            (false, _) => KeepAwake::Off,
            (true, true) => KeepAwake::Active,
            (true, false) => KeepAwake::WaitingForMains,
        };
        let inhibitor = if keep_awake == KeepAwake::Active {
            if self.held.is_none() {
                match self.inhibit.take() {
                    Ok(lock) => {
                        log::info!("Stay awake: on mains power, so automatic sleep is held off.");
                        self.held = Some(lock);
                        self.failure = None;
                    }
                    Err(reason) => {
                        if self.failure.as_deref() != Some(reason.as_str()) {
                            log::warn!("Stay awake: could not hold off automatic sleep: {reason}");
                        }
                        self.failure = Some(reason);
                    }
                }
            }
            match (&self.held, &self.failure) {
                (Some(_), _) => Inhibitor::Held,
                (None, Some(reason)) => Inhibitor::Failed {
                    reason: reason.clone(),
                },
                (None, None) => Inhibitor::None,
            }
        } else {
            if self.held.take().is_some() {
                log::info!(
                    "Stay awake: {}, so the machine sleeps normally again.",
                    if keep_awake_on_ac {
                        "on battery"
                    } else {
                        "the setting is off"
                    }
                );
            }
            self.failure = None;
            Inhibitor::None
        };
        PowerReport::Reported {
            source: reading.source,
            battery_percent: reading.battery_percent.map(round_to_five),
            keep_awake,
            inhibitor,
        }
    }

    /// Lets go of the inhibitor (the agent is stopping).
    pub fn release(&mut self) {
        if self.held.take().is_some() {
            log::info!("Stay awake: released while the agent stops.");
        }
    }
}

fn round_to_five(percent: u8) -> u8 {
    let percent = percent.min(100);
    (percent + 2) / 5 * 5
}

/// This machine's power source.
pub fn read_source() -> Reading {
    #[cfg(target_os = "linux")]
    {
        linux::read(Path::new(linux::POWER_SUPPLY_DIR))
    }
    #[cfg(windows)]
    {
        windows::read()
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        Reading {
            source: PowerSource::Unknown,
            battery_percent: None,
        }
    }
}

/// On an operating system without an inhibitor here (macOS: no agent yet).
#[cfg(not(any(target_os = "linux", windows)))]
pub struct Unsupported;

#[cfg(not(any(target_os = "linux", windows)))]
impl Inhibit for Unsupported {
    type Lock = ();
    fn take(&mut self) -> Result<(), String> {
        Err("This operating system has no sleep inhibitor in BMuster yet.".into())
    }
}

/// This operating system's inhibitor.
#[cfg(target_os = "linux")]
pub fn platform_inhibitor() -> linux::LogindInhibitor<linux::SystemBus> {
    linux::LogindInhibitor::new(linux::SystemBus)
}

#[cfg(windows)]
pub fn platform_inhibitor() -> windows::ExecutionInhibitor {
    windows::ExecutionInhibitor::new(windows::set_thread_execution_state)
}

#[cfg(not(any(target_os = "linux", windows)))]
pub fn platform_inhibitor() -> Unsupported {
    Unsupported
}

/// What the power thread hears.
enum Command {
    /// The policy, and where to say whether it changed once it is applied.
    Policy(bool, Sender<bool>),
    Stop,
}

/// The saved policy, a reader and an inhibitor: what one agent run does.
/// The thread in [`start`] drives it; tests drive it by hand.
pub struct Power<I: Inhibit> {
    data_dir: PathBuf,
    policy: bool,
    keeper: Keeper<I>,
    read: fn() -> Reading,
}

impl<I: Inhibit> Power<I> {
    /// Starts from the saved policy, before the server is reachable.
    pub fn new(data_dir: PathBuf, inhibit: I, read: fn() -> Reading) -> Self {
        let policy = load_policy(&data_dir);
        Self {
            data_dir,
            policy,
            keeper: Keeper::new(inhibit),
            read,
        }
    }

    pub fn tick(&mut self) -> PowerReport {
        self.keeper.apply(self.policy, (self.read)())
    }

    /// The server's policy: saved if it changed, then applied.
    pub fn set_policy(&mut self, keep_awake_on_ac: bool) -> PowerReport {
        if keep_awake_on_ac != self.policy {
            log::info!(
                "Stay awake on mains power is now {}.",
                if keep_awake_on_ac { "on" } else { "off" }
            );
            if let Err(error) = save_policy(&self.data_dir, keep_awake_on_ac) {
                log::warn!(
                    "Stay awake: could not save the setting ({error:#}); it applies until the agent restarts."
                );
            }
            self.policy = keep_awake_on_ac;
        }
        self.tick()
    }

    pub fn stop(&mut self) {
        self.keeper.release();
    }
}

static REPORT: Mutex<PowerReport> = Mutex::new(PowerReport::Unreported);
static COMMANDS: OnceLock<Mutex<Sender<Command>>> = OnceLock::new();

fn publish(report: PowerReport) {
    *REPORT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = report;
}

/// The inventory's `power`: `unreported` before [`start`] (other commands).
pub fn report() -> PowerReport {
    REPORT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn send(command: Command) {
    if let Some(sender) = COMMANDS.get() {
        let _ = sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .send(command);
    }
}

/// How long the socket waits for a new policy to be applied.
const APPLY_WAIT: Duration = Duration::from_secs(5);

/// The server's `power-policy` (a no-op before [`start`]). Returns once it
/// is applied, true when it changed the policy (so a check-in now carries
/// the new report).
pub fn set_policy(keep_awake_on_ac: bool) -> bool {
    let (changed, is_changed) = mpsc::channel();
    send(Command::Policy(keep_awake_on_ac, changed));
    is_changed.recv_timeout(APPLY_WAIT).unwrap_or(false)
}

/// Releases the inhibitor and ends the thread; returns once it has.
pub fn stop(thread: Option<std::thread::JoinHandle<()>>) {
    send(Command::Stop);
    if let Some(thread) = thread {
        if thread.join().is_err() {
            log::error!("The stay-awake thread failed.");
        }
    }
}

/// Starts the worker's power thread with the saved policy.
pub fn start(data_dir: PathBuf) -> Option<std::thread::JoinHandle<()>> {
    let (sender, commands) = mpsc::channel();
    if COMMANDS.set(Mutex::new(sender)).is_err() {
        return None;
    }
    let started = std::thread::Builder::new()
        .name("stay-awake".into())
        .spawn(move || {
            let mut power = Power::new(data_dir, platform_inhibitor(), read_source);
            run(&mut power, &commands, CHECK_EVERY);
        });
    match started {
        Ok(thread) => Some(thread),
        Err(error) => {
            log::error!("Could not start the stay-awake thread: {error}");
            None
        }
    }
}

fn run<I: Inhibit>(power: &mut Power<I>, commands: &Receiver<Command>, every: Duration) {
    publish(power.tick());
    loop {
        match commands.recv_timeout(every) {
            Ok(Command::Policy(on, changed)) => {
                let was = power.policy;
                publish(power.set_policy(on));
                let _ = changed.send(was != on);
            }
            Err(RecvTimeoutError::Timeout) => publish(power.tick()),
            Ok(Command::Stop) | Err(RecvTimeoutError::Disconnected) => {
                power.stop();
                publish(power.keeper.apply(false, (power.read)()));
                return;
            }
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    /// Counts takes and live locks; can be told to fail.
    #[derive(Clone, Default)]
    pub struct FakeInhibitor {
        pub state: Rc<RefCell<FakeState>>,
    }

    #[derive(Default)]
    pub struct FakeState {
        pub taken: usize,
        pub live: usize,
        pub fail_with: Option<String>,
    }

    pub struct FakeLock(Rc<RefCell<FakeState>>);

    impl Drop for FakeLock {
        fn drop(&mut self) {
            self.0.borrow_mut().live -= 1;
        }
    }

    impl Inhibit for FakeInhibitor {
        type Lock = FakeLock;
        fn take(&mut self) -> Result<FakeLock, String> {
            let mut state = self.state.borrow_mut();
            if let Some(reason) = &state.fail_with {
                return Err(reason.clone());
            }
            state.taken += 1;
            state.live += 1;
            Ok(FakeLock(Rc::clone(&self.state)))
        }
    }

    fn mains() -> Reading {
        Reading {
            source: PowerSource::Mains,
            battery_percent: Some(81),
        }
    }

    fn battery() -> Reading {
        Reading {
            source: PowerSource::Battery,
            battery_percent: Some(42),
        }
    }

    fn unknown() -> Reading {
        Reading {
            source: PowerSource::Unknown,
            battery_percent: None,
        }
    }

    fn parts(report: &PowerReport) -> (KeepAwake, Inhibitor) {
        match report {
            PowerReport::Reported {
                keep_awake,
                inhibitor,
                ..
            } => (*keep_awake, inhibitor.clone()),
            PowerReport::Unreported => panic!("unreported"),
        }
    }

    /// SPEC-STAY-AWAKE P4.
    #[test]
    fn hold_only_on_mains() {
        let fake = FakeInhibitor::default();
        let mut keeper = Keeper::new(fake.clone());

        // Off: never held, whatever the source.
        assert_eq!(
            parts(&keeper.apply(false, mains())),
            (KeepAwake::Off, Inhibitor::None)
        );
        assert_eq!(fake.state.borrow().taken, 0);

        // On and on mains: held once, not taken again every tick.
        let report = keeper.apply(true, mains());
        assert_eq!(parts(&report), (KeepAwake::Active, Inhibitor::Held));
        assert_eq!(
            report,
            PowerReport::Reported {
                source: PowerSource::Mains,
                battery_percent: Some(80),
                keep_awake: KeepAwake::Active,
                inhibitor: Inhibitor::Held,
            },
            "the percentage is rounded to 5"
        );
        keeper.apply(true, mains());
        assert_eq!(fake.state.borrow().taken, 1);
        assert_eq!(fake.state.borrow().live, 1);

        // On battery: released at once.
        assert_eq!(
            parts(&keeper.apply(true, battery())),
            (KeepAwake::WaitingForMains, Inhibitor::None)
        );
        assert_eq!(fake.state.borrow().live, 0);
        // A source the system will not say is not mains.
        assert_eq!(
            parts(&keeper.apply(true, unknown())),
            (KeepAwake::WaitingForMains, Inhibitor::None)
        );

        // Mains again, then the policy turned off: released at once.
        keeper.apply(true, mains());
        assert_eq!(fake.state.borrow().live, 1);
        assert_eq!(
            parts(&keeper.apply(false, mains())),
            (KeepAwake::Off, Inhibitor::None)
        );
        assert_eq!(fake.state.borrow().live, 0);

        // A failure is reported with its reason, and tried again next time.
        fake.state.borrow_mut().fail_with = Some("Access denied".into());
        assert_eq!(
            parts(&keeper.apply(true, mains())),
            (
                KeepAwake::Active,
                Inhibitor::Failed {
                    reason: "Access denied".into()
                }
            )
        );
        fake.state.borrow_mut().fail_with = None;
        assert_eq!(
            parts(&keeper.apply(true, mains())),
            (KeepAwake::Active, Inhibitor::Held)
        );

        // Stopping releases it.
        keeper.release();
        assert_eq!(fake.state.borrow().live, 0);
        assert!(!keeper.is_held());
    }

    /// SPEC-STAY-AWAKE P2.
    #[test]
    fn policy_persists() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!load_policy(dir.path()), "off without a saved policy");

        let fake = FakeInhibitor::default();
        let mut power = Power::new(dir.path().to_path_buf(), fake.clone(), mains);
        assert_eq!(parts(&power.tick()).0, KeepAwake::Off);
        assert_eq!(
            parts(&power.set_policy(true)),
            (KeepAwake::Active, Inhibitor::Held)
        );
        assert!(load_policy(dir.path()));
        power.stop();
        assert_eq!(fake.state.borrow().live, 0, "released when the agent stops");
        drop(power);

        // After a restart, before any server message: applied at once.
        let fake = FakeInhibitor::default();
        let mut restarted = Power::new(dir.path().to_path_buf(), fake.clone(), mains);
        assert_eq!(
            parts(&restarted.tick()),
            (KeepAwake::Active, Inhibitor::Held)
        );
        assert_eq!(fake.state.borrow().live, 1);

        // Turned off by the server: saved and released.
        assert_eq!(parts(&restarted.set_policy(false)).0, KeepAwake::Off);
        assert_eq!(fake.state.borrow().live, 0);
        assert!(!load_policy(dir.path()));

        // A damaged file reads as off.
        std::fs::write(dir.path().join(POLICY_FILE), b"{not json").unwrap();
        assert!(!load_policy(dir.path()));
        assert_eq!(
            std::fs::read_to_string(dir.path().join(POLICY_FILE)).unwrap(),
            "{not json",
            "reading never rewrites it"
        );
        save_policy(dir.path(), true).unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join(POLICY_FILE)).unwrap(),
            r#"{"keepAwakeOnAc":true}"#
        );
    }

    #[test]
    fn the_thread_applies_commands_and_releases_on_stop() {
        let dir = tempfile::tempdir().unwrap();
        let fake = FakeInhibitor::default();
        let mut power = Power::new(dir.path().to_path_buf(), fake.clone(), mains);
        let (sender, commands) = mpsc::channel();
        let (changed, is_changed) = mpsc::channel();
        sender.send(Command::Policy(true, changed.clone())).unwrap();
        sender.send(Command::Policy(true, changed)).unwrap();
        sender.send(Command::Stop).unwrap();
        run(&mut power, &commands, Duration::from_secs(5));
        assert_eq!(
            is_changed.iter().collect::<Vec<_>>(),
            [true, false],
            "the same policy again changes nothing"
        );
        assert_eq!(fake.state.borrow().taken, 1);
        assert_eq!(fake.state.borrow().live, 0);
        assert_eq!(parts(&report()), (KeepAwake::Off, Inhibitor::None));
    }
}
