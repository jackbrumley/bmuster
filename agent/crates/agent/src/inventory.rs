//! What the agent reports about its machine: inventory, load and the
//! signed-in user. Graphics cards are in `gpus.rs`. Values the system does not give are reported honestly
//! (`unknown`, an empty list or `{ kind: 'none' }`), never invented.

use anyhow::{anyhow, Result};
use bmuster_protocol::{
    CpuInfo, DiskInfo, Inventory, Load, NetworkInterface, OsInfo, SignedInUser, UpdatesPending,
};
use std::collections::BTreeMap;
use sysinfo::{Disks, Networks, System};

const UNKNOWN: &str = "unknown";

/// File systems that are not real storage.
const PSEUDO_FILE_SYSTEMS: [&str; 20] = [
    "autofs",
    "binfmt_misc",
    "bpf",
    "cgroup",
    "cgroup2",
    "configfs",
    "debugfs",
    "devpts",
    "devtmpfs",
    "efivarfs",
    "fusectl",
    "hugetlbfs",
    "mqueue",
    "overlay",
    "proc",
    "pstore",
    "ramfs",
    "squashfs",
    "sysfs",
    "tmpfs",
];

pub fn hostname() -> Result<String> {
    System::host_name()
        .filter(|name| !name.trim().is_empty())
        .ok_or_else(|| anyhow!("could not read this machine's hostname"))
}

/// Seconds since the machine started.
pub fn uptime_seconds() -> u64 {
    System::uptime()
}

/// Keeps a `System` between readings so CPU use is measured over the time
/// since the previous reading.
pub struct Probe {
    system: System,
}

impl Probe {
    pub fn new() -> Self {
        let mut system = System::new();
        system.refresh_cpu_all();
        system.refresh_memory();
        // CPU use needs two samples; give the first one a real interval.
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        Self { system }
    }

    pub fn load(&mut self) -> Load {
        self.system.refresh_cpu_usage();
        self.system.refresh_memory();
        Load {
            cpu_percent: self.system.global_cpu_usage().clamp(0.0, 100.0),
            memory_used_bytes: self.system.used_memory(),
        }
    }

    pub fn inventory(&mut self) -> Result<Inventory> {
        self.system.refresh_memory();
        let cpus = self.system.cpus();
        let model = cpus
            .first()
            .map(|cpu| cpu.brand().trim().to_string())
            .filter(|brand| !brand.is_empty())
            .unwrap_or_else(|| UNKNOWN.to_string());
        Ok(Inventory {
            os: OsInfo {
                family: std::env::consts::OS.to_string(),
                name: System::name().unwrap_or_else(|| UNKNOWN.to_string()),
                version: System::os_version().unwrap_or_else(|| UNKNOWN.to_string()),
                build: System::kernel_version().unwrap_or_default(),
                updates_pending: UpdatesPending::Unknown,
            },
            hostname: hostname()?,
            cpu: CpuInfo {
                model,
                cores: u32::try_from(cpus.len()).unwrap_or(u32::MAX),
            },
            memory_total_bytes: self.system.total_memory(),
            disks: disks(),
            // Not read yet: a Linux service has no display session of its own,
            // and a Windows service runs in session 0. SPEC-SESSIONS adds this.
            displays: Vec::new(),
            network: network(),
            gpus: crate::gpus::gpus(),
            display: crate::display_report::report(),
            power: crate::power::report(),
        })
    }
}

/// Used space rounded to 1% of the disk, so ordinary file churn does not
/// change the inventory hash on every check-in.
fn rounded_used(size: u64, used: u64) -> u64 {
    let step = size / 100;
    if step == 0 {
        return used;
    }
    (((used + step / 2) / step) * step).min(size)
}

fn disks() -> Vec<DiskInfo> {
    let disks = Disks::new_with_refreshed_list();
    let mut by_mount = BTreeMap::new();
    for disk in disks.list() {
        let fs = disk.file_system().to_string_lossy().to_lowercase();
        let mount = disk.mount_point().to_string_lossy().to_string();
        let size = disk.total_space();
        if size == 0
            || PSEUDO_FILE_SYSTEMS.contains(&fs.as_str())
            || fs.starts_with("fuse.")
            || mount.starts_with("/snap/")
        {
            continue;
        }
        let used = size.saturating_sub(disk.available_space());
        let device = disk.name().to_string_lossy().to_string();
        by_mount.entry(mount.clone()).or_insert((
            device,
            DiskInfo {
                mount,
                size_bytes: size,
                used_bytes: rounded_used(size, used),
            },
        ));
    }
    one_per_file_system(by_mount.into_values().collect())
}

/// Each file system once, at its shortest mount point. On Linux one btrfs
/// volume is mounted at `/`, `/home` and more, and the agent's own sandbox
/// adds bind mounts (`/opt/bmuster`, `/var/lib/bmuster`, `/var/tmp`) of the
/// same device: listed once, as `/`. Elsewhere every mount is its own drive.
fn one_per_file_system(mut disks: Vec<(String, DiskInfo)>) -> Vec<DiskInfo> {
    if cfg!(target_os = "linux") {
        disks.sort_by(|a, b| (a.1.mount.len(), &a.1.mount).cmp(&(b.1.mount.len(), &b.1.mount)));
        let mut seen: Vec<(String, u64)> = Vec::new();
        disks.retain(|(device, disk)| {
            let key = (device.clone(), disk.size_bytes);
            if device.is_empty() || !seen.contains(&key) {
                seen.push(key);
                true
            } else {
                false
            }
        });
        disks.sort_by(|a, b| a.1.mount.cmp(&b.1.mount));
    }
    disks.into_iter().map(|(_, disk)| disk).collect()
}

fn network() -> Vec<NetworkInterface> {
    let networks = Networks::new_with_refreshed_list();
    let mut list: Vec<NetworkInterface> = networks
        .list()
        .iter()
        .filter_map(|(name, data)| {
            let mut addresses: Vec<String> = data
                .ip_networks()
                .iter()
                .filter(|net| !net.addr.is_loopback())
                .map(|net| net.addr.to_string())
                .collect();
            if addresses.is_empty() {
                return None;
            }
            addresses.sort();
            addresses.dedup();
            Some(NetworkInterface {
                name: name.clone(),
                mac: data.mac_address().to_string(),
                addresses,
            })
        })
        .collect();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    list
}

/// The user at the machine's console, if one can be found.
pub fn signed_in_user() -> SignedInUser {
    #[cfg(target_os = "linux")]
    {
        linux_seat_user(std::path::Path::new("/run/systemd/sessions"))
    }
    #[cfg(windows)]
    {
        // The console session's user (WTSUserName and WTSDomainName); the
        // sign-in screen has none. A locked session still counts, as on Linux.
        match bmuster_desktop::winsession::console::console_user() {
            Some(name) => SignedInUser::User { name },
            None => SignedInUser::None,
        }
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        SignedInUser::None
    }
}

/// Reads systemd-logind's session files and returns the user of the active
/// session on a seat (the physical console).
#[cfg(target_os = "linux")]
fn linux_seat_user(sessions: &std::path::Path) -> SignedInUser {
    let Ok(entries) = std::fs::read_dir(sessions) else {
        return SignedInUser::None;
    };
    let mut found: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        // Only plain files: logind keeps `<id>.ref` named pipes here too, and
        // opening one as root blocks for ever (it froze the check-in loop).
        if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        let field = |key: &str| {
            text.lines()
                .find_map(|line| line.strip_prefix(key)?.strip_prefix('='))
                .map(str::to_string)
        };
        let on_seat = field("SEAT").is_some_and(|seat| !seat.is_empty());
        let active = field("ACTIVE").as_deref() == Some("1");
        let is_user = field("CLASS").as_deref() == Some("user");
        if let (true, true, true, Some(user)) = (on_seat, active, is_user, field("USER")) {
            found.push(user);
        }
    }
    found.sort();
    match found.into_iter().next() {
        Some(name) => SignedInUser::User { name },
        None => SignedInUser::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    fn disk(device: &str, mount: &str, size: u64) -> (String, DiskInfo) {
        (
            device.to_string(),
            DiskInfo {
                mount: mount.to_string(),
                size_bytes: size,
                used_bytes: size / 3,
            },
        )
    }

    /// Fedora, 0.4.17: one btrfs volume showed as seven disks.
    #[cfg(target_os = "linux")]
    #[test]
    fn each_file_system_is_listed_once_at_its_shortest_mount() {
        let listed = one_per_file_system(vec![
            disk("/dev/nvme0n1p3", "/home", 474),
            disk("/dev/nvme0n1p2", "/boot", 2),
            disk("/dev/nvme0n1p3", "/", 474),
            disk("/dev/nvme0n1p1", "/boot/efi", 1),
            disk("/dev/nvme0n1p3", "/var/lib/bmuster", 474),
            disk("/dev/nvme0n1p3", "/opt/bmuster", 474),
            disk("/dev/sdb1", "/data", 474),
        ]);
        let mounts: Vec<&str> = listed.iter().map(|d| d.mount.as_str()).collect();
        assert_eq!(mounts, ["/", "/boot", "/boot/efi", "/data"]);
    }

    #[test]
    fn used_space_is_rounded_to_one_percent() {
        assert_eq!(rounded_used(1000, 123), 120);
        assert_eq!(rounded_used(1000, 126), 130);
        assert_eq!(rounded_used(1000, 1000), 1000);
        assert_eq!(rounded_used(50, 7), 7);
    }

    #[test]
    fn inventory_is_readable_and_hash_is_stable() {
        let mut probe = Probe::new();
        let inventory = probe.inventory().unwrap();
        assert!(!inventory.hostname.is_empty());
        assert!(inventory.cpu.cores > 0);
        assert!(inventory.memory_total_bytes > 0);
        let hash = inventory.hash().unwrap();
        assert_eq!(hash.len(), 64);
        assert!(hash
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        assert_eq!(inventory.hash().unwrap(), hash);
        let load = probe.load();
        assert!((0.0..=100.0).contains(&load.cpu_percent));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn seat_user_comes_from_logind_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("2"),
            "UID=1000\nUSER=kim\nACTIVE=1\nSTATE=active\nSEAT=seat0\nCLASS=user\n",
        )
        .unwrap();
        std::fs::write(
            dir.path().join("3"),
            "UID=1001\nUSER=sshuser\nACTIVE=1\nSTATE=active\nCLASS=user\n",
        )
        .unwrap();
        assert_eq!(
            linux_seat_user(dir.path()),
            SignedInUser::User { name: "kim".into() }
        );
        assert_eq!(
            linux_seat_user(&dir.path().join("missing")),
            SignedInUser::None
        );
    }

    /// logind keeps `<id>.ref` named pipes beside the session files; reading
    /// one blocks for ever, which froze the check-in loop when run as root.
    #[cfg(target_os = "linux")]
    #[test]
    fn seat_user_skips_named_pipes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("c2"),
            "UID=1000\nUSER=jack\nACTIVE=1\nSEAT=seat0\nCLASS=user\n",
        )
        .unwrap();
        let fifo = std::ffi::CString::new(dir.path().join("c2.ref").to_str().unwrap()).unwrap();
        // SAFETY: a valid, NUL-terminated path; mkfifo only creates the node.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);

        let path = dir.path().to_path_buf();
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || send.send(linux_seat_user(&path)).unwrap());
        let found = receive
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("linux_seat_user blocked on a named pipe");
        assert_eq!(
            found,
            SignedInUser::User {
                name: "jack".into()
            }
        );
    }
}
