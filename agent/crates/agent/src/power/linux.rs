//! Linux: the power source from sysfs, and a logind inhibitor lock.
//!
//! - **Source:** `/sys/class/power_supply/*`: a `Mains` supply with `online`
//!   1 is mains power; a machine without a system battery counts as mains.
//!   Device batteries (`scope` = `Device`: a mouse, a headset) are not the
//!   machine's.
//! - **Inhibitor:** `org.freedesktop.login1.Manager.Inhibit` on the system
//!   bus with a fixed what, who, why and mode. logind keeps the lock while
//!   the returned descriptor is open; dropping it releases the lock. The
//!   agent's unit allows this: it is root, `AF_UNIX` is allowed and the bus
//!   socket under `/run` stays reachable with `ProtectSystem=strict`.

use super::{Inhibit, Reading};
use bmuster_protocol::power::PowerSource;
use std::fs;
use std::io::ErrorKind;
use std::os::fd::OwnedFd;
use std::path::Path;
use std::time::Duration;

pub const POWER_SUPPLY_DIR: &str = "/sys/class/power_supply";
/// Automatic (idle) sleep only: never shutdown, lid or keys.
pub const WHAT: &str = "sleep:idle";
pub const WHO: &str = "BMuster";
pub const WHY: &str = "Stay awake on mains power is on for this machine";
pub const MODE: &str = "block";
/// The bus call's time limit.
const CALL_TIMEOUT: Duration = Duration::from_secs(5);

fn attribute(supply: &Path, name: &str) -> Option<String> {
    fs::read_to_string(supply.join(name))
        .ok()
        .map(|text| text.trim().to_string())
}

/// The power source from a `power_supply` folder.
pub fn read(dir: &Path) -> Reading {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        // No power supplies at all: a machine without a battery.
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Reading {
                source: PowerSource::Mains,
                battery_percent: None,
            }
        }
        Err(error) => {
            log::debug!("Stay awake: could not read {}: {error}", dir.display());
            return Reading {
                source: PowerSource::Unknown,
                battery_percent: None,
            };
        }
    };
    let mut mains_online = false;
    let mut batteries = 0_u32;
    let mut capacities = Vec::new();
    for entry in entries.flatten() {
        let supply = entry.path();
        match attribute(&supply, "type").as_deref() {
            Some("Mains") => {
                if attribute(&supply, "online").as_deref() == Some("1") {
                    mains_online = true;
                }
            }
            Some("Battery") => {
                if attribute(&supply, "scope").as_deref() == Some("Device")
                    || attribute(&supply, "present").as_deref() == Some("0")
                {
                    continue;
                }
                batteries += 1;
                if let Some(capacity) =
                    attribute(&supply, "capacity").and_then(|text| text.parse::<u8>().ok())
                {
                    capacities.push(u32::from(capacity.min(100)));
                }
            }
            _ => {}
        }
    }
    let battery_percent = u32::try_from(capacities.len())
        .ok()
        .filter(|count| *count > 0)
        .and_then(|count| u8::try_from(capacities.iter().sum::<u32>() / count).ok());
    let source = if mains_online || batteries == 0 {
        PowerSource::Mains
    } else {
        PowerSource::Battery
    };
    Reading {
        source,
        battery_percent,
    }
}

/// logind's `Inhibit` call, so tests can stand in for the system bus.
pub trait LoginBus {
    fn inhibit(&self, what: &str, who: &str, why: &str, mode: &str) -> Result<OwnedFd, String>;
}

/// The logind inhibitor: the lock is the descriptor logind returned.
pub struct LogindInhibitor<B: LoginBus> {
    bus: B,
}

impl<B: LoginBus> LogindInhibitor<B> {
    pub fn new(bus: B) -> Self {
        Self { bus }
    }
}

impl<B: LoginBus> Inhibit for LogindInhibitor<B> {
    type Lock = OwnedFd;

    fn take(&mut self) -> Result<OwnedFd, String> {
        self.bus
            .inhibit(WHAT, WHO, WHY, MODE)
            .map_err(|error| format!("logind would not take the inhibitor lock: {error}"))
    }
}

/// The real system bus, through zbus (already in the build for the portal
/// and the tray). One short connection per call: the lock lives in the
/// descriptor, not the connection.
pub struct SystemBus;

impl LoginBus for SystemBus {
    fn inhibit(&self, what: &str, who: &str, why: &str, mode: &str) -> Result<OwnedFd, String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("could not start the D-Bus client: {error}"))?;
        runtime.block_on(async {
            let call = async {
                let connection = zbus::Connection::system().await?;
                let reply = connection
                    .call_method(
                        Some("org.freedesktop.login1"),
                        "/org/freedesktop/login1",
                        Some("org.freedesktop.login1.Manager"),
                        "Inhibit",
                        &(what, who, why, mode),
                    )
                    .await?;
                let fd: zbus::zvariant::OwnedFd = reply.body().deserialize()?;
                Ok::<OwnedFd, zbus::Error>(OwnedFd::from(fd))
            };
            match tokio::time::timeout(CALL_TIMEOUT, call).await {
                Ok(Ok(fd)) => Ok(fd),
                Ok(Err(error)) => Err(error.to_string()),
                Err(_) => Err(format!(
                    "the system bus did not answer within {} s",
                    CALL_TIMEOUT.as_secs()
                )),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::Keeper;
    use super::*;
    use bmuster_protocol::power::{Inhibitor, KeepAwake, PowerReport};
    use std::cell::RefCell;
    use std::io::Read as _;
    use std::os::unix::net::UnixStream;

    fn supply(root: &Path, name: &str, attributes: &[(&str, &str)]) {
        let dir = root.join(name);
        fs::create_dir_all(&dir).unwrap();
        for (attribute, value) in attributes {
            fs::write(dir.join(attribute), format!("{value}\n")).unwrap();
        }
    }

    /// SPEC-STAY-AWAKE P3.
    #[test]
    fn source_from_sysfs() {
        // Mains only (a desktop with a power supply entry).
        let desktop = tempfile::tempdir().unwrap();
        supply(desktop.path(), "AC", &[("type", "Mains"), ("online", "1")]);
        assert_eq!(
            read(desktop.path()),
            Reading {
                source: PowerSource::Mains,
                battery_percent: None
            }
        );

        // Battery only.
        let tablet = tempfile::tempdir().unwrap();
        supply(
            tablet.path(),
            "BAT0",
            &[
                ("type", "Battery"),
                ("present", "1"),
                ("capacity", "57"),
                ("scope", "System"),
            ],
        );
        assert_eq!(
            read(tablet.path()),
            Reading {
                source: PowerSource::Battery,
                battery_percent: Some(57)
            }
        );

        // Both: a laptop, plugged in and then not. A mouse battery is not the machine's.
        let laptop = tempfile::tempdir().unwrap();
        supply(laptop.path(), "ADP1", &[("type", "Mains"), ("online", "1")]);
        supply(
            laptop.path(),
            "BAT0",
            &[("type", "Battery"), ("present", "1"), ("capacity", "90")],
        );
        supply(
            laptop.path(),
            "BAT1",
            &[("type", "Battery"), ("present", "1"), ("capacity", "70")],
        );
        supply(
            laptop.path(),
            "hidpp_battery_0",
            &[("type", "Battery"), ("scope", "Device"), ("capacity", "5")],
        );
        supply(
            laptop.path(),
            "ucsi-source-psy-USBC000:001",
            &[("type", "USB"), ("online", "0")],
        );
        assert_eq!(
            read(laptop.path()),
            Reading {
                source: PowerSource::Mains,
                battery_percent: Some(80)
            }
        );
        fs::write(laptop.path().join("ADP1/online"), "0\n").unwrap();
        assert_eq!(read(laptop.path()).source, PowerSource::Battery);

        // None: no supplies, or no folder at all, is a machine without a battery.
        let empty = tempfile::tempdir().unwrap();
        assert_eq!(read(empty.path()).source, PowerSource::Mains);
        assert_eq!(
            read(&empty.path().join("missing")),
            Reading {
                source: PowerSource::Mains,
                battery_percent: None
            }
        );
        // Only a device battery (a headset on a desktop): still no system battery.
        let headset = tempfile::tempdir().unwrap();
        supply(
            headset.path(),
            "hid-battery",
            &[("type", "Battery"), ("scope", "Device"), ("capacity", "20")],
        );
        assert_eq!(read(headset.path()).source, PowerSource::Mains);
        // A battery slot without a battery.
        let slot = tempfile::tempdir().unwrap();
        supply(
            slot.path(),
            "BAT0",
            &[("type", "Battery"), ("present", "0")],
        );
        assert_eq!(read(slot.path()).source, PowerSource::Mains);
        // A folder that cannot be read is unknown.
        let file = tempfile::NamedTempFile::new().unwrap();
        assert_eq!(read(file.path()).source, PowerSource::Unknown);
    }

    /// Records each call, and hands back one end of a socket pair so the test
    /// can see when the lock is closed.
    #[derive(Default)]
    struct FakeBus {
        calls: RefCell<Vec<[String; 4]>>,
        peers: RefCell<Vec<UnixStream>>,
        fail: Option<String>,
    }

    impl LoginBus for &FakeBus {
        fn inhibit(&self, what: &str, who: &str, why: &str, mode: &str) -> Result<OwnedFd, String> {
            self.calls
                .borrow_mut()
                .push([what.into(), who.into(), why.into(), mode.into()]);
            if let Some(reason) = &self.fail {
                return Err(reason.clone());
            }
            let (ours, theirs) = UnixStream::pair().unwrap();
            self.peers.borrow_mut().push(ours);
            Ok(OwnedFd::from(theirs))
        }
    }

    /// SPEC-STAY-AWAKE P5.
    #[test]
    fn inhibitor_call() {
        let bus = FakeBus::default();
        let mut inhibitor = LogindInhibitor::new(&bus);
        let lock = inhibitor.take().unwrap();
        assert_eq!(
            bus.calls.borrow().as_slice(),
            [[
                "sleep:idle".to_string(),
                "BMuster".to_string(),
                "Stay awake on mains power is on for this machine".to_string(),
                "block".to_string()
            ]]
        );
        let mut peer = bus.peers.borrow_mut().pop().unwrap();
        peer.set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let mut byte = [0_u8; 1];
        assert!(
            peer.read(&mut byte).is_err(),
            "the descriptor stays open while the lock is held"
        );
        drop(lock);
        assert_eq!(
            peer.read(&mut byte).unwrap(),
            0,
            "releasing closes the descriptor"
        );

        // A refusal is reported with logind's reason.
        let refusing = FakeBus {
            fail: Some("org.freedesktop.DBus.Error.AccessDenied: Permission denied".into()),
            ..FakeBus::default()
        };
        let mut keeper = Keeper::new(LogindInhibitor::new(&refusing));
        let report = keeper.apply(
            true,
            Reading {
                source: PowerSource::Mains,
                battery_percent: None,
            },
        );
        assert_eq!(
            report,
            PowerReport::Reported {
                source: PowerSource::Mains,
                battery_percent: None,
                keep_awake: KeepAwake::Active,
                inhibitor: Inhibitor::Failed {
                    reason: "logind would not take the inhibitor lock: \
                             org.freedesktop.DBus.Error.AccessDenied: Permission denied"
                        .into()
                },
            }
        );
        assert!(!keeper.is_held());
    }
}
