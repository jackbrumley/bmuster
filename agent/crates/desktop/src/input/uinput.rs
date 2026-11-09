//! Input through `/dev/uinput` (SPEC-CONSOLE-CAPTURE, Input): a virtual
//! keyboard and an absolute pointer that every compositor, the X server and
//! the text console treat as real devices on seat0.
//!
//! - **"BMuster keyboard"**: `KEY_ESC` to `KEY_MICMUTE` (1–248), which holds
//!   every key [`super::keymap`] names. Higher codes are left out on purpose:
//!   the `BTN_*` range would make udev call it a mouse or a joystick.
//! - **"BMuster pointer"**: `ABS_X`/`ABS_Y` 0–65535 over the bounding box of
//!   all displays (like a QEMU USB tablet), five buttons, and the wheel with
//!   its high-resolution twin.
//!
//! The devices are made only when a control session builds its injector
//! (watch sessions never call it), shared by every control session through
//! [`Shared`], and destroyed when the last one lets go.

use super::keymap::{self, KeyPosition};
use super::{Axis, Button, InputBackend, InputError, InputResult, WHEEL_NOTCH};
use crate::capture::kms::capturer::SharedBounds;
use crate::ioctl;
use std::fs::File;
use std::io::{self, Write as _};
use std::os::fd::{AsFd, BorrowedFd};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

/// The kernel's uinput device.
pub const UINPUT: &str = "/dev/uinput";
pub const KEYBOARD_NAME: &str = "BMuster keyboard";
pub const POINTER_NAME: &str = "BMuster pointer";
/// The pointer's axes run 0..=ABS_MAX across the bounding box.
pub const ABS_MAX: i32 = 65535;
/// What `text` says for a character the US layout has no key for.
pub const CANNOT_TYPE: &str = "This character cannot be typed on this screen yet";

const EV_SYN: u16 = 0;
const EV_KEY: u16 = 1;
const EV_REL: u16 = 2;
const EV_ABS: u16 = 3;
const SYN_REPORT: u16 = 0;
const REL_HWHEEL: u16 = 6;
const REL_WHEEL: u16 = 8;
const REL_WHEEL_HI_RES: u16 = 11;
const REL_HWHEEL_HI_RES: u16 = 12;
const ABS_X: u16 = 0;
const ABS_Y: u16 = 1;
const KEY_LEFTSHIFT: u16 = 42;
const KEY_RIGHTALT: u16 = 100;
/// The last key the keyboard device registers (`KEY_MICMUTE`).
pub const LAST_KEY: u16 = 248;
const BTN_LEFT: u16 = 0x110;
const BTN_RIGHT: u16 = 0x111;
const BTN_MIDDLE: u16 = 0x112;
const BTN_SIDE: u16 = 0x113;
const BTN_EXTRA: u16 = 0x114;
const BUS_VIRTUAL: u16 = 0x06;

#[repr(C)]
struct InputId {
    bustype: u16,
    vendor: u16,
    product: u16,
    version: u16,
}

#[repr(C)]
struct Setup {
    id: InputId,
    name: [u8; 80],
    ff_effects_max: u32,
}

#[repr(C)]
struct AbsInfo {
    value: i32,
    minimum: i32,
    maximum: i32,
    fuzz: i32,
    flat: i32,
    resolution: i32,
}

#[repr(C)]
struct AbsSetup {
    code: u16,
    info: AbsInfo,
}

#[repr(C)]
struct InputEvent {
    time: libc::timeval,
    kind: u16,
    code: u16,
    value: i32,
}

const U: u8 = b'U';
const UI_DEV_CREATE: u64 = ioctl::io(U, 1);
const UI_DEV_DESTROY: u64 = ioctl::io(U, 2);
const UI_DEV_SETUP: u64 = ioctl::iow::<Setup>(U, 3);
const UI_ABS_SETUP: u64 = ioctl::iow::<AbsSetup>(U, 4);
const UI_SET_EVBIT: u64 = ioctl::iow::<libc::c_int>(U, 100);
const UI_SET_KEYBIT: u64 = ioctl::iow::<libc::c_int>(U, 101);
const UI_SET_RELBIT: u64 = ioctl::iow::<libc::c_int>(U, 102);
const UI_SET_ABSBIT: u64 = ioctl::iow::<libc::c_int>(U, 103);

/// One event: type, code, value.
pub type Event = (u16, u16, i32);

/// Which device an event goes to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    Keyboard,
    Pointer,
}

/// Where events go: the real devices, or a recorder in tests.
pub trait Sink: Send + Sync {
    /// Writes `events` then `SYN_REPORT` as one frame.
    fn emit(&self, device: Device, events: &[Event]) -> io::Result<()>;
}

/// One created uinput device; destroyed on drop.
struct Created {
    file: File,
}

impl Created {
    fn new(
        path: &Path,
        name: &str,
        setup: impl FnOnce(BorrowedFd<'_>) -> io::Result<()>,
    ) -> io::Result<Created> {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(path)?;
        setup(file.as_fd())?;
        let mut raw = Setup {
            id: InputId {
                bustype: BUS_VIRTUAL,
                vendor: 0,
                product: 0,
                version: 1,
            },
            name: [0; 80],
            ff_effects_max: 0,
        };
        raw.name[..name.len()].copy_from_slice(name.as_bytes());
        // SAFETY: UI_DEV_SETUP takes a uinput_setup; UI_DEV_CREATE takes none.
        unsafe {
            ioctl::call_with(file.as_fd(), UI_DEV_SETUP, &mut raw)?;
            ioctl::call(file.as_fd(), UI_DEV_CREATE, 0)?;
        }
        Ok(Created { file })
    }

    fn write(&self, events: &[Event]) -> io::Result<()> {
        let mut bytes = Vec::with_capacity((events.len() + 1) * std::mem::size_of::<InputEvent>());
        for &(kind, code, value) in events.iter().chain([(EV_SYN, SYN_REPORT, 0)].iter()) {
            let event = InputEvent {
                time: libc::timeval {
                    tv_sec: 0,
                    tv_usec: 0,
                },
                kind,
                code,
                value,
            };
            // SAFETY: InputEvent is plain data with no padding on Linux
            // (16-byte timeval, two u16, one i32); its bytes are read once.
            bytes.extend_from_slice(unsafe {
                std::slice::from_raw_parts(
                    &event as *const InputEvent as *const u8,
                    std::mem::size_of::<InputEvent>(),
                )
            });
        }
        (&self.file).write_all(&bytes)
    }
}

impl Drop for Created {
    fn drop(&mut self) {
        // SAFETY: UI_DEV_DESTROY takes no argument.
        if let Err(error) = unsafe { ioctl::call(self.file.as_fd(), UI_DEV_DESTROY, 0) } {
            log::warn!("Destroying a uinput device failed: {error}");
        }
    }
}

fn set_bits(
    fd: BorrowedFd<'_>,
    request: u64,
    codes: impl IntoIterator<Item = u16>,
) -> io::Result<()> {
    for code in codes {
        // SAFETY: the UI_SET_*BIT requests take an integer, passed by value.
        unsafe { ioctl::call(fd, request, libc::c_ulong::from(code)) }?;
    }
    Ok(())
}

/// The self-check's device name (SPEC-DIAGNOSTICS 1).
pub const CHECK_NAME: &str = "BMuster self-check";

/// One request the self-check makes of `/dev/uinput`. There is no variant
/// that sets a capability bit, so the check's device has no keys, buttons
/// or axes and can never type, click or move anything (SPEC-DIAGNOSTICS D3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckRequest {
    Setup,
    Create,
    Destroy,
}

impl CheckRequest {
    /// The ioctl number the request uses.
    pub fn number(self) -> u64 {
        match self {
            CheckRequest::Setup => UI_DEV_SETUP,
            CheckRequest::Create => UI_DEV_CREATE,
            CheckRequest::Destroy => UI_DEV_DESTROY,
        }
    }
}

/// The self-check's requests, in order.
pub const CHECK_REQUESTS: [CheckRequest; 3] = [
    CheckRequest::Setup,
    CheckRequest::Create,
    CheckRequest::Destroy,
];

/// The ioctls that give a device capabilities, none of which the check uses.
pub const CAPABILITY_REQUESTS: [u64; 4] =
    [UI_SET_EVBIT, UI_SET_KEYBIT, UI_SET_RELBIT, UI_SET_ABSBIT];

/// Opens `path` and makes [`CHECK_REQUESTS`]: a device with no capabilities,
/// created and destroyed at once.
pub fn check_device(path: &Path) -> io::Result<()> {
    let file = std::fs::OpenOptions::new()
        .write(true)
        .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    let mut raw = Setup {
        id: InputId {
            bustype: BUS_VIRTUAL,
            vendor: 0,
            product: 0,
            version: 1,
        },
        name: [0; 80],
        ff_effects_max: 0,
    };
    raw.name[..CHECK_NAME.len()].copy_from_slice(CHECK_NAME.as_bytes());
    let mut created = false;
    for request in CHECK_REQUESTS {
        // SAFETY: UI_DEV_SETUP takes a uinput_setup; the others take none.
        let result = unsafe {
            match request {
                CheckRequest::Setup => ioctl::call_with(file.as_fd(), request.number(), &mut raw),
                CheckRequest::Create | CheckRequest::Destroy => {
                    ioctl::call(file.as_fd(), request.number(), 0)
                }
            }
        };
        match (request, result) {
            (_, Ok(_)) => created |= request == CheckRequest::Create,
            (CheckRequest::Destroy, Err(error)) => return Err(error),
            (_, Err(error)) => {
                if created {
                    // SAFETY: UI_DEV_DESTROY takes no argument.
                    let _ = unsafe { ioctl::call(file.as_fd(), UI_DEV_DESTROY, 0) };
                }
                return Err(error);
            }
        }
    }
    Ok(())
}

/// The two devices.
pub struct Devices {
    keyboard: Created,
    pointer: Created,
}

impl Devices {
    pub fn create(path: &Path) -> io::Result<Devices> {
        let keyboard = Created::new(path, KEYBOARD_NAME, |fd| {
            set_bits(fd, UI_SET_EVBIT, [EV_KEY])?;
            set_bits(fd, UI_SET_KEYBIT, 1..=LAST_KEY)
        })?;
        let pointer = Created::new(path, POINTER_NAME, |fd| {
            set_bits(fd, UI_SET_EVBIT, [EV_KEY, EV_REL, EV_ABS])?;
            set_bits(
                fd,
                UI_SET_KEYBIT,
                [BTN_LEFT, BTN_RIGHT, BTN_MIDDLE, BTN_SIDE, BTN_EXTRA],
            )?;
            set_bits(
                fd,
                UI_SET_RELBIT,
                [REL_WHEEL, REL_HWHEEL, REL_WHEEL_HI_RES, REL_HWHEEL_HI_RES],
            )?;
            set_bits(fd, UI_SET_ABSBIT, [ABS_X, ABS_Y])?;
            for code in [ABS_X, ABS_Y] {
                let mut setup = AbsSetup {
                    code,
                    info: AbsInfo {
                        value: 0,
                        minimum: 0,
                        maximum: ABS_MAX,
                        fuzz: 0,
                        flat: 0,
                        resolution: 0,
                    },
                };
                // SAFETY: UI_ABS_SETUP takes a uinput_abs_setup.
                unsafe { ioctl::call_with(fd, UI_ABS_SETUP, &mut setup) }?;
            }
            Ok(())
        })?;
        log::info!("Created the uinput devices \"{KEYBOARD_NAME}\" and \"{POINTER_NAME}\"");
        Ok(Devices { keyboard, pointer })
    }
}

impl Drop for Devices {
    fn drop(&mut self) {
        log::info!("Destroying the uinput devices");
    }
}

impl Sink for Devices {
    fn emit(&self, device: Device, events: &[Event]) -> io::Result<()> {
        match device {
            Device::Keyboard => self.keyboard.write(events),
            Device::Pointer => self.pointer.write(events),
        }
    }
}

/// One value shared while anyone holds it, made again after the last
/// holder lets go.
pub struct Shared<T> {
    slot: Mutex<Weak<T>>,
}

impl<T> Shared<T> {
    pub const fn new() -> Self {
        Shared {
            slot: Mutex::new(Weak::new()),
        }
    }

    pub fn acquire<E>(&self, create: impl FnOnce() -> Result<T, E>) -> Result<Arc<T>, E> {
        let mut slot = self.slot.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(value) = slot.upgrade() {
            return Ok(value);
        }
        let value = Arc::new(create()?);
        *slot = Arc::downgrade(&value);
        Ok(value)
    }
}

impl<T> Default for Shared<T> {
    fn default() -> Self {
        Shared::new()
    }
}

static DEVICES: Shared<Devices> = Shared::new();

/// Makes a control session's injector: the shared devices at `path`.
#[derive(Clone)]
pub struct Opener {
    open: Arc<dyn Fn() -> InputResult<Arc<dyn Sink>> + Send + Sync>,
}

impl Opener {
    /// The system's `/dev/uinput`, shared by every control session.
    pub fn system() -> Opener {
        Opener::at(PathBuf::from(UINPUT))
    }

    pub fn at(path: PathBuf) -> Opener {
        Opener {
            open: Arc::new(move || {
                let devices = DEVICES.acquire(|| Devices::create(&path)).map_err(|e| {
                    InputError(format!(
                        "Cannot create input devices with {}: {e}",
                        path.display()
                    ))
                })?;
                Ok(devices as Arc<dyn Sink>)
            }),
        }
    }

    /// Any sink (tests).
    pub fn with(open: impl Fn() -> InputResult<Arc<dyn Sink>> + Send + Sync + 'static) -> Opener {
        Opener {
            open: Arc::new(open),
        }
    }

    pub fn backend(&self, bounds: SharedBounds) -> InputResult<Box<dyn InputBackend>> {
        Ok(Box::new(UinputBackend {
            sink: (self.open)()?,
            bounds,
            wheel: [0; 2],
        }))
    }
}

/// `offset` pixels into `size` on the 0..=ABS_MAX axis, clamped.
pub fn scale(offset: i32, size: u32) -> i32 {
    let last = i64::from(size.max(2)) - 1;
    let offset = i64::from(offset).clamp(0, last);
    (offset * i64::from(ABS_MAX) / last) as i32
}

/// The key (and whether Shift is needed) that types `character` on a US
/// layout, or `None`.
pub fn us_key(character: char) -> Option<(&'static KeyPosition, bool)> {
    let named = |code: &str, shift: bool| keymap::position(code).map(|k| (k, shift));
    match character {
        'a'..='z' => named(&format!("Key{}", character.to_ascii_uppercase()), false),
        'A'..='Z' => named(&format!("Key{character}"), true),
        '1'..='9' | '0' => named(&format!("Digit{character}"), false),
        ' ' => named("Space", false),
        _ => {
            const SYMBOLS: [(char, char, &str); 11] = [
                ('-', '_', "Minus"),
                ('=', '+', "Equal"),
                ('[', '{', "BracketLeft"),
                (']', '}', "BracketRight"),
                ('\\', '|', "Backslash"),
                (';', ':', "Semicolon"),
                ('\'', '"', "Quote"),
                ('`', '~', "Backquote"),
                (',', '<', "Comma"),
                ('.', '>', "Period"),
                ('/', '?', "Slash"),
            ];
            const DIGITS: [(char, &str); 10] = [
                ('!', "Digit1"),
                ('@', "Digit2"),
                ('#', "Digit3"),
                ('$', "Digit4"),
                ('%', "Digit5"),
                ('^', "Digit6"),
                ('&', "Digit7"),
                ('*', "Digit8"),
                ('(', "Digit9"),
                (')', "Digit0"),
            ];
            if let Some((plain, _, code)) = SYMBOLS
                .iter()
                .find(|(p, s, _)| *p == character || *s == character)
            {
                return named(code, *plain != character);
            }
            DIGITS
                .iter()
                .find(|(c, _)| *c == character)
                .and_then(|(_, code)| named(code, true))
        }
    }
}

fn button_code(button: Button) -> u16 {
    match button {
        Button::Left => BTN_LEFT,
        Button::Right => BTN_RIGHT,
        Button::Middle => BTN_MIDDLE,
        Button::Back => BTN_SIDE,
        Button::Forward => BTN_EXTRA,
    }
}

/// A control session's injector over the shared devices.
pub struct UinputBackend {
    sink: Arc<dyn Sink>,
    bounds: SharedBounds,
    /// High-resolution units not yet a whole notch, per axis.
    wheel: [i32; 2],
}

impl UinputBackend {
    fn emit(&self, device: Device, events: &[Event]) -> InputResult<()> {
        self.sink
            .emit(device, events)
            .map_err(|e| InputError(format!("uinput write failed: {e}")))
    }

    fn key_code(&self, code: u16, down: bool) -> InputResult<()> {
        self.emit(Device::Keyboard, &[(EV_KEY, code, i32::from(down))])
    }
}

impl InputBackend for UinputBackend {
    fn move_pointer(&mut self, x: i32, y: i32) -> InputResult<()> {
        let bounds = *self.bounds.lock().unwrap_or_else(|p| p.into_inner());
        self.emit(
            Device::Pointer,
            &[
                (EV_ABS, ABS_X, scale(x - bounds.x, bounds.width)),
                (EV_ABS, ABS_Y, scale(y - bounds.y, bounds.height)),
            ],
        )
    }

    fn button(&mut self, button: Button, down: bool) -> InputResult<()> {
        self.emit(
            Device::Pointer,
            &[(EV_KEY, button_code(button), i32::from(down))],
        )
    }

    fn scroll(&mut self, axis: Axis, units: i32) -> InputResult<()> {
        // evdev's wheel is positive up; ours is positive down. Horizontal
        // is positive right in both.
        let (index, high, low, value) = match axis {
            Axis::Vertical => (0, REL_WHEEL_HI_RES, REL_WHEEL, -units),
            Axis::Horizontal => (1, REL_HWHEEL_HI_RES, REL_HWHEEL, units),
        };
        self.wheel[index] += value;
        let notches = self.wheel[index] / WHEEL_NOTCH;
        self.wheel[index] -= notches * WHEEL_NOTCH;
        let mut events = vec![(EV_REL, high, value)];
        if notches != 0 {
            events.push((EV_REL, low, notches));
        }
        self.emit(Device::Pointer, &events)
    }

    fn key(&mut self, key: &KeyPosition, down: bool) -> InputResult<()> {
        self.key_code(key.evdev, down)
    }

    fn alt_gr(&mut self, down: bool) -> InputResult<()> {
        self.key_code(KEY_RIGHTALT, down)
    }

    fn type_char(&mut self, character: char) -> InputResult<()> {
        let (key, shift) = us_key(character).ok_or_else(|| InputError(CANNOT_TYPE.to_string()))?;
        if shift {
            self.key_code(KEY_LEFTSHIFT, true)?;
        }
        let typed = self
            .key_code(key.evdev, true)
            .and_then(|()| self.key_code(key.evdev, false));
        if shift {
            // Shift comes up even when the key failed.
            self.key_code(KEY_LEFTSHIFT, false)?;
        }
        typed
    }

    fn secure_attention(&mut self) -> InputResult<bool> {
        // Ctrl+Alt+Del goes as the real chord.
        Ok(false)
    }

    fn flush(&mut self) -> InputResult<()> {
        Ok(())
    }
}

#[cfg(test)]
#[path = "uinput_tests.rs"]
mod tests;
