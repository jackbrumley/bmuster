//! Windows: the power source from `GetSystemPowerStatus`, and
//! `SetThreadExecutionState` on a dedicated thread.
//!
//! The execution state belongs to the thread that set it, so each hold is a
//! thread of its own: it sets `ES_CONTINUOUS | ES_SYSTEM_REQUIRED`, waits
//! until the hold is dropped, sets `ES_CONTINUOUS` (clearing it) and ends.
//! `ES_SYSTEM_REQUIRED` only resets the idle timer: Sleep from the Start
//! menu, the lid and the power button still work, and the display may
//! still turn off (no `ES_DISPLAY_REQUIRED`).

use super::{Inhibit, Reading};
use bmuster_protocol::power::PowerSource;
use std::sync::mpsc::{self, Sender};
use std::thread::JoinHandle;

pub const ES_CONTINUOUS: u32 = 0x8000_0000;
pub const ES_SYSTEM_REQUIRED: u32 = 0x0000_0001;
/// `BatteryFlag`: no system battery.
const NO_SYSTEM_BATTERY: u8 = 128;
/// `ACLineStatus`, `BatteryFlag` and `BatteryLifePercent`: unknown.
const UNKNOWN_STATUS: u8 = 255;

/// `SetThreadExecutionState`, so tests can stand in for it. Returns the
/// previous state, 0 on failure.
pub type SetState = fn(u32) -> u32;

/// The real call.
#[cfg(windows)]
pub fn set_thread_execution_state(flags: u32) -> u32 {
    // SAFETY: plain value in, plain value out; it only changes this thread's
    // execution state.
    unsafe { windows_sys::Win32::System::Power::SetThreadExecutionState(flags) }
}

/// The power source from `SYSTEM_POWER_STATUS`'s three fields.
pub fn reading_from_status(ac_line_status: u8, battery_flag: u8, life_percent: u8) -> Reading {
    let no_battery = battery_flag != UNKNOWN_STATUS && battery_flag & NO_SYSTEM_BATTERY != 0;
    let source = match ac_line_status {
        1 => PowerSource::Mains,
        _ if no_battery => PowerSource::Mains,
        0 => PowerSource::Battery,
        _ => PowerSource::Unknown,
    };
    let battery_percent = if no_battery || life_percent == UNKNOWN_STATUS {
        None
    } else {
        Some(life_percent.min(100))
    };
    Reading {
        source,
        battery_percent,
    }
}

#[cfg(windows)]
pub fn read() -> Reading {
    let mut status = windows_sys::Win32::System::Power::SYSTEM_POWER_STATUS::default();
    // SAFETY: `status` is a valid, writable SYSTEM_POWER_STATUS.
    if unsafe { windows_sys::Win32::System::Power::GetSystemPowerStatus(&mut status) } == 0 {
        log::debug!(
            "Stay awake: GetSystemPowerStatus failed: {}",
            std::io::Error::last_os_error()
        );
        return Reading {
            source: PowerSource::Unknown,
            battery_percent: None,
        };
    }
    reading_from_status(
        status.ACLineStatus,
        status.BatteryFlag,
        status.BatteryLifePercent,
    )
}

/// Holds the system awake from a thread of its own.
pub struct ExecutionInhibitor {
    set: SetState,
}

impl ExecutionInhibitor {
    pub fn new(set: SetState) -> Self {
        Self { set }
    }
}

/// While it lives its thread keeps `ES_SYSTEM_REQUIRED`; dropping it clears
/// the state on that same thread and waits for the thread to end.
pub struct ExecutionHold {
    release: Option<Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl Drop for ExecutionHold {
    fn drop(&mut self) {
        drop(self.release.take());
        if let Some(thread) = self.thread.take() {
            if thread.join().is_err() {
                log::error!("Stay awake: the execution state thread failed.");
            }
        }
    }
}

impl Inhibit for ExecutionInhibitor {
    type Lock = ExecutionHold;

    fn take(&mut self) -> Result<ExecutionHold, String> {
        let set = self.set;
        let (release, released) = mpsc::channel::<()>();
        let (ready, is_ready) = mpsc::channel::<bool>();
        let thread = std::thread::Builder::new()
            .name("stay-awake-hold".into())
            .spawn(move || {
                if set(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) == 0 {
                    let _ = ready.send(false);
                    return;
                }
                let _ = ready.send(true);
                // Until the hold is dropped (its sender closes).
                let _ = released.recv();
                set(ES_CONTINUOUS);
            })
            .map_err(|error| format!("could not start the execution state thread: {error}"))?;
        match is_ready.recv() {
            Ok(true) => Ok(ExecutionHold {
                release: Some(release),
                thread: Some(thread),
            }),
            Ok(false) => {
                let _ = thread.join();
                Err("SetThreadExecutionState refused ES_CONTINUOUS | ES_SYSTEM_REQUIRED".into())
            }
            Err(_) => {
                let _ = thread.join();
                Err("the execution state thread stopped unexpectedly".into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::thread::ThreadId;

    static CALLS: Mutex<Vec<(ThreadId, u32)>> = Mutex::new(Vec::new());

    fn recording(flags: u32) -> u32 {
        CALLS
            .lock()
            .unwrap()
            .push((std::thread::current().id(), flags));
        ES_CONTINUOUS
    }

    fn refusing(_: u32) -> u32 {
        0
    }

    /// SPEC-STAY-AWAKE P6 (runs on every platform: only the Win32 calls are
    /// Windows code).
    #[test]
    fn execution_state() {
        let mut inhibitor = ExecutionInhibitor::new(recording);
        let hold = inhibitor.take().unwrap();
        {
            let calls = CALLS.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].1, ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
            assert_ne!(
                calls[0].0,
                std::thread::current().id(),
                "set on the dedicated thread"
            );
        }
        drop(hold);
        let calls = CALLS.lock().unwrap();
        assert_eq!(calls.len(), 2, "cleared once the hold is dropped");
        assert_eq!(calls[1], (calls[0].0, ES_CONTINUOUS), "on the same thread");
        drop(calls);

        match ExecutionInhibitor::new(refusing).take() {
            Err(reason) => assert!(reason.contains("refused"), "{reason}"),
            Ok(_) => panic!("a refused state is not a hold"),
        }
    }

    #[test]
    fn source_from_power_status() {
        // On mains with a battery at 64%.
        assert_eq!(
            reading_from_status(1, 8, 64),
            Reading {
                source: PowerSource::Mains,
                battery_percent: Some(64)
            }
        );
        // On battery.
        assert_eq!(reading_from_status(0, 0, 30).source, PowerSource::Battery);
        // A desktop: no system battery, whatever the line status says.
        assert_eq!(
            reading_from_status(UNKNOWN_STATUS, NO_SYSTEM_BATTERY, UNKNOWN_STATUS),
            Reading {
                source: PowerSource::Mains,
                battery_percent: None
            }
        );
        // Windows will not say.
        assert_eq!(
            reading_from_status(UNKNOWN_STATUS, UNKNOWN_STATUS, UNKNOWN_STATUS),
            Reading {
                source: PowerSource::Unknown,
                battery_percent: None
            }
        );
    }
}
