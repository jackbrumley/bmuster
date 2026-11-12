//! Graphics cards, integrated and discrete (SPEC-MACHINE-DETAILS D8).
//!
//! Linux reads `/sys/class/drm` and names the cards from the PCI id list;
//! Windows asks WMI (`Win32_VideoController`). The agent runs as root or
//! SYSTEM, so on Linux only regular files are opened, never a device node
//! or a named pipe that could block the check-in loop.

use bmuster_protocol::GpuInfo;
#[cfg(target_os = "linux")]
use bmuster_protocol::GpuMemory;

/// Every graphics card the system reports, in a stable order.
pub fn gpus() -> Vec<GpuInfo> {
    #[cfg(target_os = "linux")]
    {
        linux::gpus(&linux::Sources::system())
    }
    #[cfg(windows)]
    {
        windows::gpus()
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        Vec::new()
    }
}

/// Common PCI vendors, for names when no PCI id list is installed.
#[cfg(target_os = "linux")]
fn known_vendor(id: u16) -> Option<&'static str> {
    match id {
        0x10de => Some("NVIDIA"),
        0x1002 => Some("AMD"),
        0x8086 => Some("Intel"),
        _ => None,
    }
}

/// `NVIDIA Corporation` → `NVIDIA`; `Advanced Micro Devices, Inc. [AMD/ATI]` → `AMD`.
#[cfg(target_os = "linux")]
fn short_vendor(full: &str) -> String {
    if let Some(inner) = bracketed(full) {
        return inner.split('/').next().unwrap_or(inner).trim().to_string();
    }
    let mut name = full.trim();
    for suffix in [" Corporation", " Corp.", ", Inc.", " Inc.", " Ltd.", " Co."] {
        name = name.strip_suffix(suffix).unwrap_or(name);
    }
    name.trim_end_matches(',').trim().to_string()
}

/// The marketing name in square brackets, as the PCI id list writes it:
/// `AD104 [GeForce RTX 4070]` → `GeForce RTX 4070`.
#[cfg(target_os = "linux")]
fn bracketed(text: &str) -> Option<&str> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    (end > start + 1).then(|| text[start + 1..end].trim())
}

/// The card's name as people say it: `NVIDIA GeForce RTX 4070`.
#[cfg(target_os = "linux")]
fn display_name(vendor: &str, device: &str) -> String {
    let device = bracketed(device).unwrap_or(device).trim();
    if device.to_lowercase().starts_with(&vendor.to_lowercase()) {
        device.to_string()
    } else {
        format!("{vendor} {device}")
    }
}

/// Looks up a vendor and device in the PCI id list (`pci.ids` format):
/// vendors at the start of a line, their devices indented by one tab.
#[cfg(target_os = "linux")]
fn pci_names(ids: &str, vendor: u16, device: u16) -> (Option<String>, Option<String>) {
    let vendor_id = format!("{vendor:04x}");
    let device_id = format!("{device:04x}");
    let mut vendor_name: Option<String> = None;
    for line in ids.lines() {
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(rest) = line.strip_prefix('\t') {
            if vendor_name.is_some() && !rest.starts_with('\t') {
                if let Some(name) = rest
                    .strip_prefix(&device_id)
                    .and_then(|r| r.strip_prefix("  "))
                {
                    return (vendor_name, Some(name.trim().to_string()));
                }
            }
            continue;
        }
        if vendor_name.is_some() || line.starts_with("C ") {
            // The next vendor (or the device classes) began: the device is not listed.
            break;
        }
        if let Some(name) = line
            .strip_prefix(&vendor_id)
            .and_then(|r| r.strip_prefix("  "))
        {
            vendor_name = Some(name.trim().to_string());
        }
    }
    (vendor_name, None)
}

/// Name and vendor for a PCI card, from the id list when it knows them.
#[cfg(target_os = "linux")]
fn describe(ids: Option<&str>, vendor: u16, device: u16) -> (String, String) {
    let (vendor_name, device_name) = ids.map_or((None, None), |ids| pci_names(ids, vendor, device));
    let short = vendor_name
        .as_deref()
        .map(short_vendor)
        .or_else(|| known_vendor(vendor).map(str::to_string));
    let name = match (&short, device_name) {
        (Some(short), Some(device)) => display_name(short, &device),
        (Some(short), None) => format!("{short} device 0x{device:04x}"),
        (None, _) => format!("Vendor 0x{vendor:04x} device 0x{device:04x}"),
    };
    let vendor_text = vendor_name
        .or(short)
        .unwrap_or_else(|| format!("0x{vendor:04x}"));
    (name, vendor_text)
}

#[cfg(target_os = "linux")]
fn known_memory(bytes: Option<u64>) -> GpuMemory {
    match bytes {
        Some(bytes) if bytes > 0 => GpuMemory::Known { bytes },
        _ => GpuMemory::Unknown,
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{describe, known_memory};
    use bmuster_protocol::GpuInfo;
    use std::collections::BTreeSet;
    use std::io::Read;
    use std::path::{Path, PathBuf};

    /// The biggest file read: the PCI id list is about 1.5 MB.
    const PCI_IDS_LIMIT: u64 = 16 * 1024 * 1024;
    /// sysfs attributes are one short line.
    const ATTRIBUTE_LIMIT: u64 = 4096;

    /// Where to look; tests point these at a temporary tree.
    pub struct Sources {
        pub drm: PathBuf,
        pub pci_ids: Vec<PathBuf>,
        pub modules: PathBuf,
    }

    impl Sources {
        #[cfg(target_os = "linux")]
        pub fn system() -> Self {
            Self {
                drm: PathBuf::from("/sys/class/drm"),
                pci_ids: vec![
                    PathBuf::from("/usr/share/misc/pci.ids"),
                    PathBuf::from("/usr/share/hwdata/pci.ids"),
                ],
                modules: PathBuf::from("/sys/module"),
            }
        }
    }

    pub fn gpus(sources: &Sources) -> Vec<GpuInfo> {
        let Ok(entries) = std::fs::read_dir(&sources.drm) else {
            return Vec::new();
        };
        // `card0`, `card1`, …: one per card. `card0-DP-1` (a connector) and
        // `renderD128` (a render node) are skipped.
        let mut cards: Vec<(u32, PathBuf)> = entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name();
                let number = name.to_str()?.strip_prefix("card")?.parse::<u32>().ok()?;
                Some((number, entry.path().join("device")))
            })
            .collect();
        cards.sort_by_key(|(number, _)| *number);

        let mut ids: Option<Option<String>> = None;
        let mut seen = BTreeSet::new();
        let mut found = Vec::new();
        for (_, device) in cards {
            // Cards without PCI ids (firmware frame buffers such as simpledrm) are not graphics cards.
            let (Some(vendor), Some(device_id)) = (
                read_hex(&device.join("vendor")),
                read_hex(&device.join("device")),
            ) else {
                continue;
            };
            if let Ok(real) = std::fs::canonicalize(&device) {
                if !seen.insert(real) {
                    continue;
                }
            }
            let ids = ids.get_or_insert_with(|| {
                sources
                    .pci_ids
                    .iter()
                    .find_map(|path| read_regular(path, PCI_IDS_LIMIT))
            });
            let (name, vendor_text) = describe(ids.as_deref(), vendor, device_id);
            found.push(GpuInfo {
                name,
                vendor: vendor_text,
                // amdgpu reports dedicated memory; others (and integrated cards) do not.
                memory_bytes: known_memory(
                    read_regular(&device.join("mem_info_vram_total"), ATTRIBUTE_LIMIT)
                        .and_then(|text| text.trim().parse().ok()),
                ),
                driver: driver(&device, &sources.modules),
            });
        }
        found
    }

    /// The kernel driver's name, with its version when the module reports one (`nvidia 550.54`).
    fn driver(device: &Path, modules: &Path) -> String {
        let Some(name) = std::fs::read_link(device.join("driver"))
            .ok()
            .and_then(|target| target.file_name()?.to_str().map(str::to_string))
        else {
            return String::new();
        };
        match read_regular(&modules.join(&name).join("version"), ATTRIBUTE_LIMIT) {
            Some(version) if !version.trim().is_empty() => format!("{name} {}", version.trim()),
            _ => name,
        }
    }

    /// `0x10de\n` → 0x10de.
    fn read_hex(path: &Path) -> Option<u16> {
        let text = read_regular(path, ATTRIBUTE_LIMIT)?;
        u16::from_str_radix(text.trim().strip_prefix("0x")?, 16).ok()
    }

    /// Reads a file only if it is a regular file, at most `limit` bytes.
    /// A named pipe or device node would block a root service for ever, so
    /// those are never opened; `O_NONBLOCK` covers a file swapped for a pipe
    /// between the check and the open.
    fn read_regular(path: &Path, limit: u64) -> Option<String> {
        if !std::fs::metadata(path).ok()?.is_file() {
            return None;
        }
        let mut options = std::fs::OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let file = options.open(path).ok()?;
        if !file.metadata().ok()?.is_file() {
            return None;
        }
        let mut bytes = Vec::new();
        file.take(limit).read_to_end(&mut bytes).ok()?;
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use bmuster_protocol::GpuMemory;
        use std::os::unix::fs::symlink;

        const PCI_IDS: &str = "\
# pci.ids sample
10de  NVIDIA Corporation
\t2786  AD104 [GeForce RTX 4070]
\t\t1043 8888  ASUS card
8086  Intel Corporation
\t4680  AlderLake-S GT1 [UHD Graphics 770]
1002  Advanced Micro Devices, Inc. [AMD/ATI]
\t73bf  Navi 21 [Radeon RX 6800/6800 XT / 6900 XT]
C 03  Display controller
";

        struct Tree {
            _dir: tempfile::TempDir,
            root: PathBuf,
            sources: Sources,
        }

        fn tree(with_ids: bool) -> Tree {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().to_path_buf();
            let ids = root.join("pci.ids");
            if with_ids {
                std::fs::write(&ids, PCI_IDS).unwrap();
            }
            std::fs::create_dir_all(root.join("drm")).unwrap();
            std::fs::create_dir_all(root.join("module")).unwrap();
            std::fs::create_dir_all(root.join("drivers")).unwrap();
            let sources = Sources {
                drm: root.join("drm"),
                pci_ids: vec![root.join("missing.ids"), ids],
                modules: root.join("module"),
            };
            Tree {
                _dir: dir,
                root,
                sources,
            }
        }

        /// A PCI device at `devices/<slot>`, linked as `drm/<card>/device`.
        fn card(tree: &Tree, card: &str, slot: &str, ids: (&str, &str), driver: &str) -> PathBuf {
            let device = tree.root.join("devices").join(slot);
            std::fs::create_dir_all(&device).unwrap();
            std::fs::write(device.join("vendor"), format!("{}\n", ids.0)).unwrap();
            std::fs::write(device.join("device"), format!("{}\n", ids.1)).unwrap();
            let driver_dir = tree.root.join("drivers").join(driver);
            std::fs::create_dir_all(&driver_dir).unwrap();
            symlink(&driver_dir, device.join("driver")).unwrap();
            let card_dir = tree.sources.drm.join(card);
            std::fs::create_dir_all(&card_dir).unwrap();
            symlink(&device, card_dir.join("device")).unwrap();
            device
        }

        #[test]
        fn names_cards_from_the_pci_id_list_with_memory_and_driver() {
            let tree = tree(true);
            card(
                &tree,
                "card1",
                "0000:01:00.0",
                ("0x10de", "0x2786"),
                "nvidia",
            );
            card(&tree, "card0", "0000:00:02.0", ("0x8086", "0x4680"), "i915");
            let amd = card(
                &tree,
                "card2",
                "0000:03:00.0",
                ("0x1002", "0x73bf"),
                "amdgpu",
            );
            std::fs::write(amd.join("mem_info_vram_total"), "17163091968\n").unwrap();
            std::fs::create_dir_all(tree.sources.modules.join("nvidia")).unwrap();
            std::fs::write(tree.sources.modules.join("nvidia/version"), "550.54.14\n").unwrap();
            // A connector and a render node: not cards.
            std::fs::create_dir_all(tree.sources.drm.join("card1-DP-1")).unwrap();
            std::fs::create_dir_all(tree.sources.drm.join("renderD128")).unwrap();

            assert_eq!(
                gpus(&tree.sources),
                vec![
                    GpuInfo {
                        name: "Intel UHD Graphics 770".into(),
                        vendor: "Intel Corporation".into(),
                        memory_bytes: GpuMemory::Unknown,
                        driver: "i915".into(),
                    },
                    GpuInfo {
                        name: "NVIDIA GeForce RTX 4070".into(),
                        vendor: "NVIDIA Corporation".into(),
                        memory_bytes: GpuMemory::Unknown,
                        driver: "nvidia 550.54.14".into(),
                    },
                    GpuInfo {
                        name: "AMD Radeon RX 6800/6800 XT / 6900 XT".into(),
                        vendor: "Advanced Micro Devices, Inc. [AMD/ATI]".into(),
                        memory_bytes: GpuMemory::Known {
                            bytes: 17_163_091_968
                        },
                        driver: "amdgpu".into(),
                    },
                ]
            );
        }

        #[test]
        fn falls_back_to_ids_without_a_pci_id_list() {
            let tree = tree(false);
            card(
                &tree,
                "card0",
                "0000:01:00.0",
                ("0x10de", "0x2786"),
                "nouveau",
            );
            card(
                &tree,
                "card1",
                "0000:02:00.0",
                ("0x1234", "0x1111"),
                "bochs-drm",
            );
            let found = gpus(&tree.sources);
            assert_eq!(found[0].name, "NVIDIA device 0x2786");
            assert_eq!(found[0].vendor, "NVIDIA");
            assert_eq!(found[1].name, "Vendor 0x1234 device 0x1111");
            assert_eq!(found[1].vendor, "0x1234");
        }

        #[test]
        fn skips_cards_without_pci_ids_and_reports_none_without_drm() {
            let tree = tree(true);
            // simpledrm: a platform device with no vendor or device file.
            let platform = tree.root.join("devices/simple-framebuffer.0");
            std::fs::create_dir_all(&platform).unwrap();
            std::fs::create_dir_all(tree.sources.drm.join("card0")).unwrap();
            symlink(&platform, tree.sources.drm.join("card0/device")).unwrap();
            assert_eq!(gpus(&tree.sources), Vec::new());

            let missing = Sources {
                drm: tree.root.join("no-drm"),
                pci_ids: Vec::new(),
                modules: tree.root.join("no-module"),
            };
            assert_eq!(gpus(&missing), Vec::new());
        }

        /// Opening a named pipe for reading blocks until a writer appears; as
        /// root under systemd that would freeze the check-in loop.
        #[test]
        fn never_opens_a_named_pipe() {
            let tree = tree(true);
            let device = card(
                &tree,
                "card0",
                "0000:01:00.0",
                ("0x10de", "0x2786"),
                "nvidia",
            );
            let vram = std::ffi::CString::new(device.join("mem_info_vram_total").to_str().unwrap())
                .unwrap();
            // SAFETY: a valid, NUL-terminated path; mkfifo only creates the node.
            assert_eq!(unsafe { libc::mkfifo(vram.as_ptr(), 0o600) }, 0);
            std::fs::create_dir_all(tree.sources.modules.join("nvidia")).unwrap();
            let version = std::ffi::CString::new(
                tree.sources
                    .modules
                    .join("nvidia/version")
                    .to_str()
                    .unwrap(),
            )
            .unwrap();
            // SAFETY: as above.
            assert_eq!(unsafe { libc::mkfifo(version.as_ptr(), 0o600) }, 0);
            // The PCI id list itself is a pipe too.
            let ids = std::ffi::CString::new(tree.root.join("pci.ids").to_str().unwrap()).unwrap();
            std::fs::remove_file(tree.root.join("pci.ids")).unwrap();
            // SAFETY: as above.
            assert_eq!(unsafe { libc::mkfifo(ids.as_ptr(), 0o600) }, 0);

            let sources = Sources {
                drm: tree.sources.drm.clone(),
                pci_ids: tree.sources.pci_ids.clone(),
                modules: tree.sources.modules.clone(),
            };
            let (send, receive) = std::sync::mpsc::channel();
            std::thread::spawn(move || send.send(gpus(&sources)).unwrap());
            let found = receive
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("gpus() blocked on a named pipe");
            assert_eq!(
                found,
                vec![GpuInfo {
                    name: "NVIDIA device 0x2786".into(),
                    vendor: "NVIDIA".into(),
                    memory_bytes: GpuMemory::Unknown,
                    driver: "nvidia".into(),
                }]
            );
        }

        #[test]
        fn reads_only_regular_files() {
            let tree = tree(true);
            assert_eq!(
                read_regular(&tree.root.join("pci.ids"), 10).as_deref(),
                Some("# pci.ids ")
            );
            assert_eq!(read_regular(&tree.root.join("drm"), 10), None);
            assert_eq!(read_regular(&tree.root.join("nothing"), 10), None);
        }
    }
}

#[cfg(windows)]
mod windows {
    use bmuster_protocol::{GpuInfo, GpuMemory};
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename = "Win32_VideoController")]
    struct VideoController {
        #[serde(rename = "Name")]
        name: Option<String>,
        #[serde(rename = "AdapterCompatibility")]
        adapter_compatibility: Option<String>,
        #[serde(rename = "AdapterRAM")]
        adapter_ram: Option<u32>,
        #[serde(rename = "DriverVersion")]
        driver_version: Option<String>,
        #[serde(rename = "PNPDeviceID")]
        pnp_device_id: Option<String>,
    }

    static WMI_FALLBACK: crate::logging::FirstWarning = crate::logging::FirstWarning::new();

    /// AdapterRAM is 32 bits: cards with 4 GB or more report about this much.
    const ADAPTER_RAM_CAPPED: u32 = 0xFFF0_0000;

    pub fn gpus() -> Vec<GpuInfo> {
        let controllers: Vec<VideoController> = match wmi::WMIConnection::new()
            .and_then(|connection| connection.query())
        {
            Ok(list) => list,
            Err(error) => {
                // A damaged WMI repository answers "invalid class"
                // (0x80041010) for Win32_VideoController, as on a Windows
                // 10 machine in 0.4.17: the registry still knows the cards.
                // It stays damaged, and inventory runs every few minutes:
                // warn once a run, then debug.
                let found = registry_gpus();
                log::log!(
                    WMI_FALLBACK.level(),
                    "could not list graphics cards through WMI ({error}); found {} in the registry instead",
                    found.len()
                );
                return found;
            }
        };
        let mut found: Vec<(String, GpuInfo)> = controllers
            .into_iter()
            .filter_map(|controller| {
                let device_id = controller.pnp_device_id.unwrap_or_default();
                // Software adapters (Remote Display, virtual displays) are not cards.
                let upper = device_id.to_ascii_uppercase();
                if upper.starts_with("SWD\\") || upper.starts_with("ROOT\\") {
                    return None;
                }
                let name = controller.name?.trim().to_string();
                let memory_bytes = match registry_memory(&device_id) {
                    Some(bytes) if bytes > 0 => GpuMemory::Known { bytes },
                    _ => match controller.adapter_ram {
                        Some(ram) if ram > 0 && ram < ADAPTER_RAM_CAPPED => GpuMemory::Known {
                            bytes: u64::from(ram),
                        },
                        _ => GpuMemory::Unknown,
                    },
                };
                Some((
                    device_id,
                    GpuInfo {
                        name,
                        vendor: controller
                            .adapter_compatibility
                            .unwrap_or_default()
                            .trim()
                            .to_string(),
                        memory_bytes,
                        driver: controller
                            .driver_version
                            .unwrap_or_default()
                            .trim()
                            .to_string(),
                    },
                ))
            })
            .collect();
        found.sort_by(|a, b| a.0.cmp(&b.0));
        found.into_iter().map(|(_, gpu)| gpu).collect()
    }

    /// The display adapters class (`GUID_DEVCLASS_DISPLAY`).
    const DISPLAY_CLASS: &str = "{4d36e968-e325-11ce-bfc1-08002be10318}";

    /// Graphics cards from the registry, for when WMI cannot answer: each PCI
    /// device of the display class, named by its `DeviceDesc`, with the driver
    /// and memory from its driver key. PCI only, so software adapters (remote
    /// display, virtual screens) are left out, as with WMI.
    fn registry_gpus() -> Vec<GpuInfo> {
        let machine = windows_registry::LOCAL_MACHINE;
        let Ok(pci) = machine.open("SYSTEM\\CurrentControlSet\\Enum\\PCI") else {
            return Vec::new();
        };
        let Ok(devices) = pci.keys() else {
            return Vec::new();
        };
        let mut found: Vec<(String, GpuInfo)> = Vec::new();
        for device in devices {
            let Ok(device_key) = pci.open(&device) else {
                continue;
            };
            let Ok(instances) = device_key.keys() else {
                continue;
            };
            for instance in instances {
                let Ok(key) = device_key.open(&instance) else {
                    continue;
                };
                let is_display = key
                    .get_string("ClassGUID")
                    .is_ok_and(|class| class.eq_ignore_ascii_case(DISPLAY_CLASS));
                if !is_display {
                    continue;
                }
                let Some(name) = key.get_string("DeviceDesc").ok().map(|d| inf_text(&d)) else {
                    continue;
                };
                let device_id = format!("PCI\\{device}\\{instance}");
                let driver_key = key.get_string("Driver").ok().and_then(|driver| {
                    machine
                        .open(format!(
                            "SYSTEM\\CurrentControlSet\\Control\\Class\\{driver}"
                        ))
                        .ok()
                });
                let vendor = key
                    .get_string("Mfg")
                    .ok()
                    .map(|m| inf_text(&m))
                    .or_else(|| {
                        driver_key
                            .as_ref()
                            .and_then(|k| k.get_string("ProviderName").ok())
                    })
                    .unwrap_or_default();
                let driver = driver_key
                    .as_ref()
                    .and_then(|k| k.get_string("DriverVersion").ok())
                    .unwrap_or_default();
                let memory_bytes = match registry_memory(&device_id) {
                    Some(bytes) if bytes > 0 => GpuMemory::Known { bytes },
                    _ => GpuMemory::Unknown,
                };
                found.push((
                    device_id,
                    GpuInfo {
                        name,
                        vendor: vendor.trim().to_string(),
                        memory_bytes,
                        driver: driver.trim().to_string(),
                    },
                ));
            }
        }
        found.sort_by(|a, b| a.0.cmp(&b.0));
        found.into_iter().map(|(_, gpu)| gpu).collect()
    }

    /// Registry text from a driver package is often `@oem3.inf,%id%;Intel(R)
    /// HD Graphics`: the readable part follows the last `;`.
    fn inf_text(value: &str) -> String {
        value
            .rsplit_once(';')
            .map_or(value, |(_, text)| text)
            .trim()
            .to_string()
    }

    /// The video memory Windows itself shows (dxdiag, Task Manager): the
    /// driver's `HardwareInformation.qwMemorySize`, found through the device's
    /// `Driver` key.
    fn registry_memory(pnp_device_id: &str) -> Option<u64> {
        if pnp_device_id.is_empty() {
            return None;
        }
        let machine = windows_registry::LOCAL_MACHINE;
        let driver = machine
            .open(format!("SYSTEM\\CurrentControlSet\\Enum\\{pnp_device_id}"))
            .ok()?
            .get_string("Driver")
            .ok()?;
        let class = machine
            .open(format!(
                "SYSTEM\\CurrentControlSet\\Control\\Class\\{driver}"
            ))
            .ok()?;
        if let Ok(bytes) = class.get_u64("HardwareInformation.qwMemorySize") {
            return Some(bytes);
        }
        let value = class.get_value("HardwareInformation.MemorySize").ok()?;
        let bytes: &[u8] = value.as_ref();
        match bytes.len() {
            4 => Some(u64::from(u32::from_le_bytes(bytes.try_into().ok()?))),
            8 => Some(u64::from_le_bytes(bytes.try_into().ok()?)),
            _ => None,
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn vendor_and_card_names_read_as_people_say_them() {
        assert_eq!(short_vendor("NVIDIA Corporation"), "NVIDIA");
        assert_eq!(short_vendor("Intel Corporation"), "Intel");
        assert_eq!(
            short_vendor("Advanced Micro Devices, Inc. [AMD/ATI]"),
            "AMD"
        );
        assert_eq!(short_vendor("Red Hat, Inc."), "Red Hat");
        assert_eq!(
            display_name("NVIDIA", "AD104 [GeForce RTX 4070]"),
            "NVIDIA GeForce RTX 4070"
        );
        assert_eq!(
            display_name("VMware", "SVGA II Adapter"),
            "VMware SVGA II Adapter"
        );
        assert_eq!(display_name("Intel", "Intel Iris Xe"), "Intel Iris Xe");
    }

    #[test]
    fn pci_ids_lookup_stops_at_the_next_vendor() {
        let ids = "10de  NVIDIA Corporation\n\t1111  One\n8086  Intel Corporation\n\t2222  Two\n";
        assert_eq!(
            pci_names(ids, 0x10de, 0x1111),
            (Some("NVIDIA Corporation".into()), Some("One".into()))
        );
        assert_eq!(
            pci_names(ids, 0x10de, 0x2222),
            (Some("NVIDIA Corporation".into()), None)
        );
        assert_eq!(pci_names(ids, 0xabcd, 0x1111), (None, None));
        assert_eq!(known_memory(Some(0)), GpuMemory::Unknown);
    }
}
