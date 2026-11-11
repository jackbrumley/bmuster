//! Staying out of the way (SPEC-STORAGE 3.2): the lowest priority the system
//! has, a duty cycle, and pauses on battery and while the machine is busy.

use bmuster_protocol::power::PowerSource;
use std::time::{Duration, Instant};

/// Work this long, then sleep.
const SLICE: Duration = Duration::from_millis(50);
/// How often the power source and CPU are read again.
pub const CHECK_EVERY: Duration = Duration::from_secs(30);
/// Above this machine-wide CPU use the scan waits.
pub const BUSY_PERCENT: f32 = 70.0;

/// How hard a pass works.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Speed {
    /// The daily pass: sleeps 4 times as long as it worked.
    Background,
    /// Rescan now: sleeps as long as it worked.
    Asked,
}

impl Speed {
    fn sleep_factor(self) -> u32 {
        match self {
            Speed::Background => 4,
            Speed::Asked => 1,
        }
    }

    /// How long to sleep after working `worked` in one slice; nothing until
    /// the slice is full.
    pub fn sleep_after(self, worked: Duration) -> Option<Duration> {
        (worked >= SLICE).then(|| worked * self.sleep_factor())
    }
}

/// Whether the scan waits: on battery, or while the CPU is busy.
pub fn should_pause(source: PowerSource, cpu_percent: f32) -> bool {
    source == PowerSource::Battery || cpu_percent > BUSY_PERCENT
}

/// The duty cycle and the pauses, between folders.
pub struct Pace {
    speed: Speed,
    slice_started: Instant,
    checked: Instant,
    system: sysinfo::System,
}

impl Pace {
    pub fn new(speed: Speed) -> Self {
        let mut system = sysinfo::System::new();
        system.refresh_cpu_usage();
        let now = Instant::now();
        Self {
            speed,
            slice_started: now,
            checked: now,
            system,
        }
    }

    /// Sleeps when the slice is full, and waits while the scan should pause.
    pub fn between_folders(&mut self) {
        if let Some(sleep) = self.speed.sleep_after(self.slice_started.elapsed()) {
            std::thread::sleep(sleep);
            self.slice_started = Instant::now();
        }
        if self.checked.elapsed() < CHECK_EVERY {
            return;
        }
        loop {
            self.system.refresh_cpu_usage();
            self.checked = Instant::now();
            let cpu = self.system.global_cpu_usage();
            let source = power_source();
            if !should_pause(source, cpu) {
                break;
            }
            log::debug!("Storage scan paused ({source:?}, CPU {cpu:.0} %).");
            std::thread::sleep(CHECK_EVERY);
        }
        self.slice_started = Instant::now();
    }
}

#[cfg(target_os = "linux")]
fn power_source() -> PowerSource {
    crate::power::linux::read(std::path::Path::new(crate::power::linux::POWER_SUPPLY_DIR)).source
}

#[cfg(windows)]
fn power_source() -> PowerSource {
    crate::power::windows::read().source
}

#[cfg(not(any(target_os = "linux", windows)))]
fn power_source() -> PowerSource {
    PowerSource::Unknown
}

/// Lowers this process to the lowest CPU and disk priority. Call it before
/// starting any thread: on Linux both settings are per thread.
#[cfg(target_os = "linux")]
pub fn lower_priority() {
    const IOPRIO_WHO_PROCESS: libc::c_long = 1;
    const IOPRIO_CLASS_IDLE: libc::c_long = 3;
    const IOPRIO_CLASS_SHIFT: libc::c_long = 13;
    // SAFETY: plain system calls on this thread, with constant arguments.
    let nice = unsafe { libc::setpriority(libc::PRIO_PROCESS, 0, 19) };
    if nice != 0 {
        log::warn!(
            "Storage scan: could not lower its CPU priority: {}",
            std::io::Error::last_os_error()
        );
    }
    // SAFETY: as above; ioprio_set has no libc wrapper.
    let io = unsafe {
        libc::syscall(
            libc::SYS_ioprio_set,
            IOPRIO_WHO_PROCESS,
            0 as libc::c_long,
            IOPRIO_CLASS_IDLE << IOPRIO_CLASS_SHIFT,
        )
    };
    if io != 0 {
        log::warn!(
            "Storage scan: could not lower its disk priority: {}",
            std::io::Error::last_os_error()
        );
    }
}

/// Background mode: the lowest CPU, disk and memory priority.
#[cfg(windows)]
pub fn lower_priority() {
    use windows_sys::Win32::System::Threading::{
        GetCurrentProcess, SetPriorityClass, PROCESS_MODE_BACKGROUND_BEGIN,
    };
    // SAFETY: the pseudo-handle of this process and a constant mode.
    let ok = unsafe { SetPriorityClass(GetCurrentProcess(), PROCESS_MODE_BACKGROUND_BEGIN) };
    if ok == 0 {
        log::warn!(
            "Storage scan: could not enter background mode: {}",
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
pub fn lower_priority() {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn s7_the_scan_pauses_on_battery_and_while_busy() {
        assert!(should_pause(PowerSource::Battery, 0.0));
        assert!(should_pause(PowerSource::Mains, 90.0));
        assert!(!should_pause(PowerSource::Mains, 20.0));
        assert!(!should_pause(PowerSource::Unknown, 20.0));
    }

    #[test]
    fn s7_the_scan_sleeps_four_times_its_work_or_once_when_asked() {
        let worked = Duration::from_millis(60);
        assert_eq!(
            Speed::Background.sleep_after(worked),
            Some(Duration::from_millis(240))
        );
        assert_eq!(Speed::Asked.sleep_after(worked), Some(worked));
        assert_eq!(
            Speed::Background.sleep_after(Duration::from_millis(10)),
            None
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn lowering_the_priority_of_a_thread_works_without_root() {
        std::thread::spawn(|| {
            lower_priority();
            // SAFETY: reads this thread's nice value.
            let nice = unsafe { libc::getpriority(libc::PRIO_PROCESS, 0) };
            assert_eq!(nice, 19);
        })
        .join()
        .unwrap();
    }
}
