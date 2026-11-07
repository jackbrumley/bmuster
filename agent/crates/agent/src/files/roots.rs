//! Where browsing starts (SPEC-FILES F2): drives on Windows, `/` and the real
//! mount points elsewhere, each with its size and free space.

use bmuster_protocol::files::{FilesResult, Root, RootKind};
use std::path::Path;

/// (total, free for the agent) bytes of the file system holding `path`.
#[cfg(unix)]
pub fn space(path: &Path) -> Option<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt as _;
    let mut bytes = path.as_os_str().as_bytes().to_vec();
    bytes.push(0);
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `bytes` is NUL-terminated and `stats` is a valid out-pointer.
    let status = unsafe { libc::statvfs(bytes.as_ptr().cast(), &mut stats) };
    if status != 0 {
        return None;
    }
    let unit = widen(stats.f_frsize);
    Some((
        widen(stats.f_blocks).saturating_mul(unit),
        widen(stats.f_bavail).saturating_mul(unit),
    ))
}

/// statvfs's field types differ between platforms (u32 on macOS, u64 on Linux).
#[cfg(unix)]
fn widen<T: Into<u64>>(value: T) -> u64 {
    value.into()
}

#[cfg(windows)]
fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt as _;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
pub fn space(path: &Path) -> Option<(u64, u64)> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let name = wide(path);
    let (mut available, mut total, mut free) = (0u64, 0u64, 0u64);
    // SAFETY: `name` is NUL-terminated; the out-pointers are valid u64s.
    let ok = unsafe { GetDiskFreeSpaceExW(name.as_ptr(), &mut available, &mut total, &mut free) };
    (ok != 0).then_some((total, available))
}

fn root(path: String, label: String, kind: RootKind) -> Root {
    let (total_bytes, free_bytes) = match space(Path::new(&path)) {
        Some((total, free)) => (Some(total), Some(free)),
        None => (None, None),
    };
    Root {
        path,
        label,
        kind,
        total_bytes,
        free_bytes,
    }
}

#[cfg(windows)]
pub fn roots() -> FilesResult {
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};
    const DRIVE_REMOVABLE: u32 = 2;
    const DRIVE_FIXED: u32 = 3;
    const DRIVE_REMOTE: u32 = 4;
    const DRIVE_CDROM: u32 = 5;
    const DRIVE_RAMDISK: u32 = 6;
    // SAFETY: no arguments; returns a bit mask of drive letters.
    let mask = unsafe { GetLogicalDrives() };
    let mut found = Vec::new();
    for (index, letter) in ('A'..='Z').enumerate() {
        if mask & (1 << index) == 0 {
            continue;
        }
        let path = format!("{letter}:\\");
        // SAFETY: a NUL-terminated wide string.
        let kind = unsafe { GetDriveTypeW(wide(Path::new(&path)).as_ptr()) };
        let label = match kind {
            DRIVE_FIXED => "Local disk",
            DRIVE_REMOVABLE => "Removable drive",
            DRIVE_REMOTE => "Network drive",
            DRIVE_CDROM => "CD or DVD drive",
            DRIVE_RAMDISK => "RAM disk",
            _ => "Drive",
        };
        found.push(root(path, label.into(), RootKind::Drive));
    }
    FilesResult::Roots { roots: found }
}

/// File system types that are real storage people browse.
#[cfg(target_os = "linux")]
fn is_storage(device: &str, fs_type: &str) -> bool {
    const KINDS: [&str; 12] = [
        "ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "vfat", "exfat", "ntfs", "ntfs3", "nfs",
        "nfs4",
    ];
    const MORE: [&str; 5] = ["cifs", "smb3", "fuseblk", "f2fs", "fuse.sshfs"];
    KINDS.contains(&fs_type) || MORE.contains(&fs_type) || device.starts_with("/dev/")
}

/// `/proc/mounts` writes a space in a mount point as `\040` (octal).
#[cfg(target_os = "linux")]
fn unescape_mount(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let octal = bytes.get(index + 1..index + 4).and_then(|digits| {
            let digits = std::str::from_utf8(digits).ok()?;
            u8::from_str_radix(digits, 8).ok()
        });
        match (bytes[index], octal) {
            (b'\\', Some(value)) => {
                out.push(value);
                index += 4;
            }
            (byte, _) => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `/` first, then each real mount point once, from `/proc/self/mounts` text.
#[cfg(target_os = "linux")]
fn mount_points(mounts: &str) -> Vec<(String, String)> {
    let mut found: Vec<(String, String)> = vec![("/".into(), "Root file system".into())];
    for line in mounts.lines() {
        let mut fields = line.split_whitespace();
        let (Some(device), Some(point), Some(fs_type)) =
            (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        let point = unescape_mount(point);
        let skip = point == "/"
            || point.starts_with("/snap/")
            || point.starts_with("/proc")
            || point.starts_with("/sys")
            || point.starts_with("/dev")
            || point.starts_with("/run/")
            || !is_storage(device, fs_type)
            || device.starts_with("/dev/loop");
        if !skip && !found.iter().any(|(known, _)| *known == point) {
            found.push((point, fs_type.to_string()));
        }
    }
    found
}

#[cfg(target_os = "linux")]
pub fn roots() -> FilesResult {
    let mounts = std::fs::read_to_string("/proc/self/mounts").unwrap_or_default();
    FilesResult::Roots {
        roots: mount_points(&mounts)
            .into_iter()
            .map(|(path, label)| root(path, label, RootKind::Mount))
            .collect(),
    }
}

#[cfg(all(unix, not(target_os = "linux")))]
pub fn roots() -> FilesResult {
    let mut found = vec![root("/".into(), "Root file system".into(), RootKind::Mount)];
    if let Ok(volumes) = std::fs::read_dir("/Volumes") {
        for volume in volumes.flatten() {
            let path = volume.path();
            let is_mount = std::fs::symlink_metadata(&path)
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false);
            if is_mount {
                found.push(root(
                    path.to_string_lossy().into_owned(),
                    "Volume".into(),
                    RootKind::Mount,
                ));
            }
        }
    }
    FilesResult::Roots { roots: found }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn mount_points_keep_real_storage_once() {
        let mounts = "\
sysfs /sys sysfs rw 0 0
proc /proc proc rw 0 0
/dev/nvme0n1p2 / ext4 rw 0 0
/dev/nvme0n1p1 /boot/efi vfat rw 0 0
tmpfs /run tmpfs rw 0 0
/dev/loop3 /snap/core/1 squashfs ro 0 0
/dev/sdb1 /media/kim/My\\040Disk exfat rw 0 0
nas:/share /mnt/nas nfs4 rw 0 0
/dev/sdb1 /media/kim/My\\040Disk exfat rw 0 0
";
        assert_eq!(
            mount_points(mounts),
            vec![
                ("/".to_string(), "Root file system".to_string()),
                ("/boot/efi".to_string(), "vfat".to_string()),
                ("/media/kim/My Disk".to_string(), "exfat".to_string()),
                ("/mnt/nas".to_string(), "nfs4".to_string()),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn roots_start_at_the_root_with_its_space() {
        let FilesResult::Roots { roots } = roots() else {
            panic!("not roots")
        };
        let first = &roots[0];
        assert_eq!(first.path, "/");
        assert!(first.total_bytes.unwrap_or(0) > 0);
        assert!(first.free_bytes.is_some());
    }
}
