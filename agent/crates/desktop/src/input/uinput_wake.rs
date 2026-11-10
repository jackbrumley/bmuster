//! The wake device (SPEC-DESKTOP-WAKE): "BMuster wake", a uinput pointer
//! that can only move by relative steps. A nudge moves it one unit right
//! and back, which every idle monitor (Mutter, KWin, Xorg) counts as
//! activity, so a blanked screen comes on and an open one stays on, while
//! the pointer ends where it started.
//!
//! - **Capabilities:** `REL_X`, `REL_Y` and `BTN_LEFT` only. libinput
//!   classes a device as a pointer only with a button, which is never
//!   pressed. No keys, no absolute axes: it cannot click or type.
//! - **Relative, not absolute:** the input core drops an absolute event
//!   equal to the last value, so "move to where it is" would never arrive.
//! - **Kept:** libinput takes a moment to listen to a new device, so the
//!   device lives as long as a control session holds it (shared like the
//!   other devices), never made per nudge.

use super::{set_bits, Created, Event, Shared, BTN_LEFT, EV_KEY, EV_REL, UINPUT};
use super::{UI_SET_EVBIT, UI_SET_KEYBIT, UI_SET_RELBIT};
use crate::follow::Waker;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const WAKE_NAME: &str = "BMuster wake";
const REL_X: u16 = 0;
const REL_Y: u16 = 1;

/// The device's event types, buttons and relative axes.
pub const WAKE_EVENT_TYPES: [u16; 2] = [EV_KEY, EV_REL];
pub const WAKE_BUTTONS: [u16; 1] = [BTN_LEFT];
pub const WAKE_AXES: [u16; 2] = [REL_X, REL_Y];

/// One nudge: each entry is written as its own frame (then `SYN_REPORT`).
pub const NUDGE: [Event; 2] = [(EV_REL, REL_X, 1), (EV_REL, REL_X, -1)];

/// Where the wake device's frames go: the real device, or a recorder.
pub trait WakeSink: Send + Sync {
    /// Writes `events` then `SYN_REPORT` as one frame.
    fn emit(&self, events: &[Event]) -> io::Result<()>;
}

pub struct WakeDevice(Created);

impl WakeDevice {
    pub fn create(path: &Path) -> io::Result<WakeDevice> {
        let created = Created::new(path, WAKE_NAME, |fd| {
            set_bits(fd, UI_SET_EVBIT, WAKE_EVENT_TYPES)?;
            set_bits(fd, UI_SET_KEYBIT, WAKE_BUTTONS)?;
            set_bits(fd, UI_SET_RELBIT, WAKE_AXES)
        })?;
        log::info!("Created the uinput device \"{WAKE_NAME}\"");
        Ok(WakeDevice(created))
    }
}

impl Drop for WakeDevice {
    fn drop(&mut self) {
        log::info!("Destroying the uinput device \"{WAKE_NAME}\"");
    }
}

impl WakeSink for WakeDevice {
    fn emit(&self, events: &[Event]) -> io::Result<()> {
        self.0.write(events)
    }
}

static WAKE: Shared<WakeDevice> = Shared::new();

/// Nudges through a wake sink.
pub struct UinputWaker {
    sink: Arc<dyn WakeSink>,
}

impl UinputWaker {
    pub fn new(sink: Arc<dyn WakeSink>) -> Self {
        UinputWaker { sink }
    }

    /// The shared device on the system's `/dev/uinput`.
    pub fn system() -> Result<Self, String> {
        UinputWaker::at(PathBuf::from(UINPUT))
    }

    pub fn at(path: PathBuf) -> Result<Self, String> {
        let device = WAKE
            .acquire(|| WakeDevice::create(&path))
            .map_err(|e| format!("Cannot create the wake device with {}: {e}", path.display()))?;
        Ok(UinputWaker::new(device))
    }
}

impl Waker for UinputWaker {
    fn nudge(&mut self) -> Result<(), String> {
        for event in NUDGE {
            self.sink
                .emit(&[event])
                .map_err(|e| format!("uinput write failed: {e}"))?;
        }
        Ok(())
    }
}
