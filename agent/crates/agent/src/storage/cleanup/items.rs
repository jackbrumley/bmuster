//! The fixed clean-up list (SPEC-STORAGE 11.2): what each item id means on
//! this machine. Everything is decided here from the id and the machine's
//! own folders; the request carries nothing else.
//!
//! Both systems' items are plain data built from [`Machine`], so the
//! Windows list is tested on Linux against temporary trees; only the
//! delete itself ([`super::safe`]) differs per system.

use super::sweep::{self, checked_root, real_folders, Outcome, Root, Rule, Target};
use bmuster_protocol::cleanup::{CleanupItem, CleanupSize, ItemResult, Measured};
use std::ffi::{OsStr, OsString};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

/// `/var/tmp` (Q14).
pub const VAR_TMP_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Windows temporary folders, as Windows' own Disk Clean-up (Q14).
pub const WINDOWS_TEMP_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// What `journalctl --vacuum-size` keeps.
pub const JOURNAL_KEEP: u64 = 200 * 1024 * 1024;
/// A system tool's time limit unless stated.
const COMMAND_LIMIT: Duration = Duration::from_secs(10 * 60);
const DISM_LIMIT: Duration = Duration::from_secs(2 * 60 * 60);
const FLATPAK_LIMIT: Duration = Duration::from_secs(30 * 60);

/// Windows' folders, from the service's environment.
#[derive(Debug, Clone)]
pub struct WindowsFolders {
    /// `%SystemRoot%`
    pub system_root: PathBuf,
    /// `%SystemDrive%\Users`
    pub users: PathBuf,
    /// The fixed drives' roots (`C:\`).
    pub drives: Vec<PathBuf>,
}

/// Linux's folders: everything below `root` (`/`, or a test tree).
#[derive(Debug, Clone)]
pub struct LinuxFolders {
    pub root: PathBuf,
}

#[derive(Debug, Clone)]
pub enum Machine {
    Windows(WindowsFolders),
    Linux(LinuxFolders),
}

impl Machine {
    /// This machine; `None` where the agent has no clean-up (no system
    /// folder in the environment on Windows, or another system).
    pub fn this() -> Option<Machine> {
        if cfg!(windows) {
            let system_root = PathBuf::from(std::env::var_os("SystemRoot")?);
            let drive = std::env::var_os("SystemDrive")?;
            let users = PathBuf::from(format!("{}\\Users", drive.to_string_lossy()));
            let drives = crate::files::roots::scan_targets()
                .into_iter()
                .map(PathBuf::from)
                .collect();
            Some(Machine::Windows(WindowsFolders {
                system_root,
                users,
                drives,
            }))
        } else if cfg!(target_os = "linux") {
            Some(Machine::Linux(LinuxFolders { root: "/".into() }))
        } else {
            None
        }
    }
}

/// One system tool, with a fixed argument list and a time limit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tool {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub limit: Duration,
}

impl Tool {
    fn new(program: PathBuf, args: &[&str], limit: Duration) -> Self {
        Self {
            program,
            args: args.iter().map(OsString::from).collect(),
            limit,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// The safe sweep deletes the targets' files.
    Sweep,
    /// The system's own tools clean; freed is the targets' size before
    /// minus after, or (with `free_space_of`) the drive's free space.
    Run {
        tools: Vec<Tool>,
        free_space_of: Option<PathBuf>,
    },
}

/// What an item is on this machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    pub targets: Vec<Target>,
    /// Roots dropped because a part of them is a link.
    pub linked: Vec<PathBuf>,
    /// Bytes the tool keeps (the journal's 200 MiB).
    pub keep_bytes: u64,
    pub action: Action,
}

impl Plan {
    fn sweep() -> Self {
        Self {
            targets: Vec::new(),
            linked: Vec::new(),
            keep_bytes: 0,
            action: Action::Sweep,
        }
    }

    fn run(tools: Vec<Tool>, free_space_of: Option<PathBuf>) -> Self {
        Self {
            action: Action::Run {
                tools,
                free_space_of,
            },
            ..Self::sweep()
        }
    }

    fn add(&mut self, root: Root, rule: Rule) {
        match root {
            Root::Missing => {}
            Root::Linked(path) => self.linked.push(path),
            Root::Ready(root) => self.targets.push(Target { root, rule }),
        }
    }

    /// A sweep with no folder at all does not apply to the machine.
    fn offered(self) -> Option<Self> {
        match self.action {
            Action::Sweep if self.targets.is_empty() && self.linked.is_empty() => None,
            Action::Run { ref tools, .. } if tools.is_empty() => None,
            _ => Some(self),
        }
    }
}

fn parts(relative: &str) -> Vec<&OsStr> {
    relative
        .split(['/', '\\'])
        .filter(|part| !part.is_empty())
        .map(OsStr::new)
        .collect()
}

fn aged(min_age: Duration) -> Rule {
    Rule {
        min_age: Some(min_age),
        ..Rule::default()
    }
}

fn windows(folders: &WindowsFolders, id: CleanupItem) -> Option<Plan> {
    let system = |relative: &str| checked_root(&folders.system_root, &parts(relative));
    let profiles = |relative: &str| -> Vec<Root> {
        real_folders(&folders.users)
            .iter()
            .map(|profile| {
                let mut below = vec![profile.as_os_str()];
                below.extend(parts(relative));
                checked_root(&folders.users, &below)
            })
            .collect()
    };
    let mut plan = Plan::sweep();
    match id {
        CleanupItem::WindowsUserTemp => {
            for root in profiles("AppData/Local/Temp") {
                plan.add(root, aged(WINDOWS_TEMP_AGE));
            }
        }
        CleanupItem::WindowsTemp => plan.add(system("Temp"), aged(WINDOWS_TEMP_AGE)),
        CleanupItem::WindowsUpdateCache => {
            plan.add(system("SoftwareDistribution/Download"), Rule::default());
        }
        CleanupItem::DeliveryOptimisationCache => plan.add(
            system(
                "ServiceProfiles/NetworkService/AppData/Local/Microsoft/Windows/DeliveryOptimization/Cache",
            ),
            Rule::default(),
        ),
        CleanupItem::WindowsCrashDumps => {
            plan.add(system("Minidump"), Rule::default());
            if folders.system_root.join("MEMORY.DMP").is_file() {
                let only = Rule {
                    only_name: Some("MEMORY.DMP"),
                    ..Rule::default()
                };
                plan.add(system(""), only);
            }
            for root in profiles("AppData/Local/CrashDumps") {
                plan.add(root, Rule::default());
            }
        }
        CleanupItem::RecycleBins => {
            let rule = Rule {
                keep_top_folders: true,
                keep_names: &["desktop.ini"],
                ..Rule::default()
            };
            for drive in &folders.drives {
                plan.add(checked_root(drive, &[OsStr::new("$Recycle.Bin")]), rule);
            }
        }
        CleanupItem::ComponentStore => {
            let dism = folders.system_root.join("System32").join("Dism.exe");
            if !dism.is_file() {
                return None;
            }
            let tool = Tool::new(
                dism,
                &["/Online", "/Cleanup-Image", "/StartComponentCleanup"],
                DISM_LIMIT,
            );
            return Some(Plan::run(vec![tool], Some(folders.system_root.clone())));
        }
        CleanupItem::PackageCache
        | CleanupItem::Journal
        | CleanupItem::LinuxCrashDumps
        | CleanupItem::OldVarTmp
        | CleanupItem::UnusedFlatpaks
        | CleanupItem::ThumbnailCaches => return None,
    }
    plan.offered()
}

fn linux(folders: &LinuxFolders, id: CleanupItem) -> Option<Plan> {
    let root = &folders.root;
    let system = |relative: &str| checked_root(root, &parts(relative));
    let program = |name: &str| root.join("usr/bin").join(name);
    match id {
        CleanupItem::PackageCache => {
            let mut tools = Vec::new();
            let mut sized = Plan::sweep();
            if program("apt-get").is_file() {
                let deb = Rule {
                    extension: Some("deb"),
                    ..Rule::default()
                };
                sized.add(system("var/cache/apt/archives"), deb);
                tools.push(Tool::new(program("apt-get"), &["clean"], COMMAND_LIMIT));
            }
            if program("dnf").is_file() {
                let rpm = Rule {
                    extension: Some("rpm"),
                    ..Rule::default()
                };
                sized.add(system("var/cache/dnf"), rpm);
                sized.add(system("var/cache/libdnf5"), rpm);
                tools.push(Tool::new(
                    program("dnf"),
                    &["clean", "packages"],
                    COMMAND_LIMIT,
                ));
            }
            Plan {
                targets: sized.targets,
                linked: sized.linked,
                ..Plan::run(tools, None)
            }
            .offered()
        }
        CleanupItem::Journal => {
            if !program("journalctl").is_file() {
                return None;
            }
            let mut plan = Plan::run(
                vec![Tool::new(
                    program("journalctl"),
                    &["--vacuum-size=200M"],
                    COMMAND_LIMIT,
                )],
                None,
            );
            let journal = Rule {
                extension: Some("journal"),
                ..Rule::default()
            };
            plan.add(system("var/log/journal"), journal);
            plan.keep_bytes = JOURNAL_KEEP;
            (!plan.targets.is_empty()).then_some(plan)
        }
        CleanupItem::LinuxCrashDumps => {
            let mut plan = Plan::sweep();
            plan.add(system("var/lib/systemd/coredump"), Rule::default());
            plan.add(system("var/crash"), Rule::default());
            plan.offered()
        }
        CleanupItem::OldVarTmp => {
            let mut plan = Plan::sweep();
            let rule = Rule {
                min_age: Some(VAR_TMP_AGE),
                skip_top_prefixes: &["systemd-private-"],
                ..Rule::default()
            };
            plan.add(system("var/tmp"), rule);
            plan.offered()
        }
        CleanupItem::UnusedFlatpaks => {
            if !program("flatpak").is_file() {
                return None;
            }
            let tool = Tool::new(
                program("flatpak"),
                &[
                    "uninstall",
                    "--unused",
                    "-y",
                    "--noninteractive",
                    "--system",
                ],
                FLATPAK_LIMIT,
            );
            Some(Plan::run(vec![tool], Some(root.clone())))
        }
        CleanupItem::ThumbnailCaches => {
            let mut plan = Plan::sweep();
            let homes = root.join("home");
            for home in real_folders(&homes) {
                let below = [
                    home.as_os_str(),
                    OsStr::new(".cache"),
                    OsStr::new("thumbnails"),
                ];
                plan.add(checked_root(&homes, &below), Rule::default());
            }
            plan.add(system("root/.cache/thumbnails"), Rule::default());
            plan.offered()
        }
        CleanupItem::WindowsUserTemp
        | CleanupItem::WindowsTemp
        | CleanupItem::WindowsUpdateCache
        | CleanupItem::DeliveryOptimisationCache
        | CleanupItem::WindowsCrashDumps
        | CleanupItem::RecycleBins
        | CleanupItem::ComponentStore => None,
    }
}

/// What `id` is on `machine`, or `None` when it does not apply there.
pub fn plan(machine: &Machine, id: CleanupItem) -> Option<Plan> {
    match machine {
        Machine::Windows(folders) => windows(folders, id),
        Machine::Linux(folders) => linux(folders, id),
    }
}

/// What the item would free now.
pub fn size(plan: &Plan, now: SystemTime) -> CleanupSize {
    if let Action::Run {
        free_space_of: Some(_),
        ..
    } = plan.action
    {
        return CleanupSize::Unknown;
    }
    let tally = sweep::size(&plan.targets, now);
    let bytes = tally.bytes.saturating_sub(plan.keep_bytes);
    CleanupSize::Bytes {
        bytes,
        files: if bytes == 0 { 0 } else { tally.files },
    }
}

fn free_space(path: &Path) -> Option<u64> {
    crate::files::roots::space(path).map(|(_, free)| free)
}

/// Runs one tool to the end or its limit. `Err` says why, in plain words.
pub fn run_tool(tool: &Tool) -> Result<(), String> {
    let name = tool.program.file_name().map_or_else(
        || tool.program.display().to_string(),
        |name| name.to_string_lossy().into_owned(),
    );
    let mut command = Command::new(&tool.program);
    command
        .args(&tool.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // Windows tools need the service's environment (SystemRoot and the like).
    #[cfg(unix)]
    command
        .env_clear()
        .env("PATH", crate::exec::spawn::UNIX_PATH)
        .env("LANG", "C.UTF-8");
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start {name}: {e}"))?;
    let stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(stderr) = stderr {
            let _ = stderr.take(16 * 1024).read_to_string(&mut text);
        }
        text
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > tool.limit => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "{name} took longer than {} minutes and was stopped.",
                    tool.limit.as_secs() / 60
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(200)),
            Err(e) => return Err(format!("Could not wait for {name}: {e}")),
        }
    };
    let said = reader.join().unwrap_or_default();
    if status.success() {
        return Ok(());
    }
    let last = said
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    Err(format!("{name} ended with {status}. {}", last.trim())
        .trim()
        .to_string())
}

/// Cleans one item. `progress` hears the bytes freed so far (the sweep).
pub fn clean(plan: &Plan, now: SystemTime, progress: &mut dyn FnMut(&Outcome)) -> ItemResult {
    let mut outcome = Outcome::default();
    for linked in &plan.linked {
        outcome.error(format!(
            "Skipped {}: a part of it is a link, so it was not touched.",
            linked.display()
        ));
    }
    let measured = match &plan.action {
        Action::Sweep => {
            outcome.add(sweep::clean(&plan.targets, now, progress));
            Measured::Counted
        }
        Action::Run {
            tools,
            free_space_of,
        } => {
            let before = match free_space_of {
                Some(drive) => free_space(drive).unwrap_or(0),
                None => {
                    let tally = sweep::size(&plan.targets, now);
                    outcome.removed = tally.files;
                    tally.bytes
                }
            };
            for tool in tools {
                if let Err(message) = run_tool(tool) {
                    outcome.error(message);
                }
            }
            match free_space_of {
                Some(drive) => {
                    outcome.freed_bytes = free_space(drive).unwrap_or(0).saturating_sub(before);
                    Measured::FreeSpace
                }
                None => {
                    let after = sweep::size(&plan.targets, now);
                    outcome.freed_bytes = before.saturating_sub(after.bytes);
                    outcome.removed = outcome.removed.saturating_sub(after.files);
                    Measured::Counted
                }
            }
        }
    };
    ItemResult {
        freed_bytes: outcome.freed_bytes,
        measured,
        files_removed: outcome.removed,
        files_skipped: outcome.skipped,
        errors: outcome.errors,
        messages: outcome.messages,
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use bmuster_protocol::cleanup::CLEANUP_ITEMS;
    use std::fs;
    use std::os::unix::fs::PermissionsExt as _;

    const DAY: Duration = Duration::from_secs(24 * 60 * 60);

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![1u8; bytes]).unwrap();
    }

    fn tree() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        (dir, root)
    }

    /// An executable script standing in for a system tool.
    fn tool(root: &Path, name: &str, script: &str) {
        let path = root.join("usr/bin").join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn windows_tree() -> (tempfile::TempDir, Machine, PathBuf) {
        let (dir, base) = tree();
        let machine = Machine::Windows(WindowsFolders {
            system_root: base.join("Windows"),
            users: base.join("Users"),
            drives: vec![base.join("C"), base.join("D")],
        });
        fs::create_dir_all(base.join("Windows")).unwrap();
        fs::create_dir_all(base.join("Users")).unwrap();
        (dir, machine, base)
    }

    fn roots(plan: &Plan) -> Vec<PathBuf> {
        plan.targets
            .iter()
            .map(|target| target.root.clone())
            .collect()
    }

    fn files(size: &CleanupSize) -> u64 {
        match size {
            CleanupSize::Bytes { files, .. } => *files,
            CleanupSize::Unknown => panic!("unknown"),
        }
    }

    #[test]
    fn s16_windows_items_find_their_folders() {
        let (_dir, machine, base) = windows_tree();
        assert!(
            plan(&machine, CleanupItem::WindowsTemp).is_none(),
            "no folder, not offered"
        );
        write(&base.join("Users/ada/AppData/Local/Temp/a.tmp"), 10);
        write(&base.join("Users/bob/AppData/Local/Temp/b.tmp"), 10);
        write(&base.join("Users/bob/AppData/Local/CrashDumps/app.dmp"), 10);
        std::os::unix::fs::symlink(base.join("Users/ada"), base.join("Users/All Users")).unwrap();
        write(&base.join("Windows/Temp/w.tmp"), 10);
        write(
            &base.join("Windows/SoftwareDistribution/Download/x.cab"),
            10,
        );
        write(&base.join("Windows/Minidump/1.dmp"), 10);
        write(&base.join("Windows/MEMORY.DMP"), 10);
        write(&base.join("Windows/notepad.exe"), 10);
        write(&base.join("C/$Recycle.Bin/S-1/$Rold"), 10);
        write(&base.join("D/$Recycle.Bin/S-1/desktop.ini"), 10);
        write(
            &base.join("Windows/ServiceProfiles/NetworkService/AppData/Local/Microsoft/Windows/DeliveryOptimization/Cache/blob"),
            10,
        );

        let users = plan(&machine, CleanupItem::WindowsUserTemp).unwrap();
        assert_eq!(
            roots(&users),
            [
                base.join("Users/ada/AppData/Local/Temp"),
                base.join("Users/bob/AppData/Local/Temp")
            ],
            "the All Users junction is not a profile"
        );
        assert_eq!(users.targets[0].rule.min_age, Some(WINDOWS_TEMP_AGE));

        let dumps = plan(&machine, CleanupItem::WindowsCrashDumps).unwrap();
        let now = SystemTime::now();
        assert_eq!(
            files(&size(&dumps, now)),
            3,
            "Minidump, MEMORY.DMP, the profile's dumps"
        );

        let bins = plan(&machine, CleanupItem::RecycleBins).unwrap();
        assert_eq!(
            roots(&bins),
            [base.join("C/$Recycle.Bin"), base.join("D/$Recycle.Bin")]
        );
        assert_eq!(files(&size(&bins, now)), 1, "desktop.ini stays");

        for id in [
            CleanupItem::WindowsUpdateCache,
            CleanupItem::DeliveryOptimisationCache,
        ] {
            assert_eq!(files(&size(&plan(&machine, id).unwrap(), now)), 1);
        }
        assert!(
            plan(&machine, CleanupItem::ComponentStore).is_none(),
            "no Dism.exe"
        );
        write(&base.join("Windows/System32/Dism.exe"), 1);
        let dism = plan(&machine, CleanupItem::ComponentStore).unwrap();
        assert_eq!(size(&dism, now), CleanupSize::Unknown);
        let Action::Run { tools, .. } = &dism.action else {
            panic!("not a tool");
        };
        assert_eq!(
            tools[0].args,
            ["/Online", "/Cleanup-Image", "/StartComponentCleanup"]
        );
        for linux_item in [
            CleanupItem::OldVarTmp,
            CleanupItem::PackageCache,
            CleanupItem::Journal,
        ] {
            assert!(plan(&machine, linux_item).is_none());
        }
    }

    #[test]
    fn s14_windows_temp_keeps_files_for_seven_days() {
        let (_dir, machine, base) = windows_tree();
        write(&base.join("Windows/Temp/w.tmp"), 10);
        let temp = plan(&machine, CleanupItem::WindowsTemp).unwrap();
        assert_eq!(files(&size(&temp, SystemTime::now())), 0);
        assert_eq!(files(&size(&temp, SystemTime::now() + 8 * DAY)), 1);
        assert_eq!(WINDOWS_TEMP_AGE, 7 * DAY);
        assert_eq!(VAR_TMP_AGE, 30 * DAY);
    }

    #[test]
    fn s16_linux_items_find_their_folders_and_tools() {
        let (_dir, root) = tree();
        let machine = Machine::Linux(LinuxFolders { root: root.clone() });
        for id in CLEANUP_ITEMS {
            assert!(
                plan(&machine, id).is_none(),
                "{id:?} offered on an empty machine"
            );
        }
        write(&root.join("var/cache/apt/archives/a.deb"), 10);
        write(&root.join("var/cache/apt/archives/lock"), 10);
        write(&root.join("var/crash/x.crash"), 10);
        write(&root.join("var/tmp/new"), 10);
        write(&root.join("home/ada/.cache/thumbnails/normal/t.png"), 10);
        write(&root.join("root/.cache/thumbnails/large/r.png"), 10);
        write(&root.join("var/log/journal/m/system.journal"), 10);
        assert!(
            plan(&machine, CleanupItem::PackageCache).is_none(),
            "no apt-get or dnf"
        );
        tool(&root, "apt-get", "exit 0");
        tool(&root, "journalctl", "exit 0");
        let now = SystemTime::now();

        let packages = plan(&machine, CleanupItem::PackageCache).unwrap();
        assert_eq!(files(&size(&packages, now)), 1, "only the .deb files");
        assert_eq!(
            files(&size(
                &plan(&machine, CleanupItem::LinuxCrashDumps).unwrap(),
                now
            )),
            1
        );
        let thumbs = plan(&machine, CleanupItem::ThumbnailCaches).unwrap();
        assert_eq!(files(&size(&thumbs, now)), 2);
        let journal = plan(&machine, CleanupItem::Journal).unwrap();
        assert_eq!(
            size(&journal, now),
            CleanupSize::Bytes { bytes: 0, files: 0 },
            "under 200 MiB frees nothing"
        );
        assert!(plan(&machine, CleanupItem::UnusedFlatpaks).is_none());
        tool(&root, "flatpak", "exit 0");
        assert_eq!(
            size(&plan(&machine, CleanupItem::UnusedFlatpaks).unwrap(), now),
            CleanupSize::Unknown
        );
        let var_tmp = plan(&machine, CleanupItem::OldVarTmp).unwrap();
        assert_eq!(var_tmp.targets[0].rule.min_age, Some(VAR_TMP_AGE));
        assert_eq!(
            var_tmp.targets[0].rule.skip_top_prefixes,
            ["systemd-private-"]
        );
        for windows_item in [CleanupItem::RecycleBins, CleanupItem::WindowsTemp] {
            assert!(plan(&machine, windows_item).is_none());
        }
    }

    #[test]
    fn s16_a_tool_item_measures_before_and_after() {
        let (_dir, root) = tree();
        let machine = Machine::Linux(LinuxFolders { root: root.clone() });
        write(&root.join("var/cache/apt/archives/a.deb"), 9000);
        write(&root.join("var/cache/apt/archives/partial/b.deb"), 9000);
        let archives = root.join("var/cache/apt/archives");
        tool(
            &root,
            "apt-get",
            &format!("rm -f '{}'/*.deb", archives.display()),
        );
        let packages = plan(&machine, CleanupItem::PackageCache).unwrap();
        let result = clean(&packages, SystemTime::now(), &mut |_| {});
        assert_eq!(result.files_removed, 1);
        assert!(result.freed_bytes >= 9000);
        assert_eq!(result.measured, Measured::Counted);
        assert_eq!(result.errors, 0);
        assert!(
            archives.join("partial/b.deb").exists(),
            "the tool decides what goes"
        );
    }

    #[test]
    fn s16_a_failing_tool_is_an_error_with_its_last_words() {
        let (_dir, root) = tree();
        tool(&root, "dnf", "echo 'Error: database is locked' >&2; exit 1");
        write(&root.join("var/cache/dnf/x.rpm"), 10);
        let machine = Machine::Linux(LinuxFolders { root: root.clone() });
        let result = clean(
            &plan(&machine, CleanupItem::PackageCache).unwrap(),
            SystemTime::now(),
            &mut |_| {},
        );
        assert_eq!(result.errors, 1);
        assert!(
            result.messages[0].contains("database is locked"),
            "{:?}",
            result.messages
        );
        let slow = Tool::new(
            PathBuf::from("/bin/sleep"),
            &["5"],
            Duration::from_millis(100),
        );
        assert!(run_tool(&slow).unwrap_err().contains("was stopped"));
    }

    #[test]
    fn s13_a_linked_home_cache_is_reported_and_untouched() {
        let (_dir, root) = tree();
        write(&root.join("etc/passwd"), 10);
        fs::create_dir_all(root.join("home/mallory/.cache")).unwrap();
        std::os::unix::fs::symlink(
            root.join("etc"),
            root.join("home/mallory/.cache/thumbnails"),
        )
        .unwrap();
        write(&root.join("home/ada/.cache/thumbnails/t.png"), 10);
        let machine = Machine::Linux(LinuxFolders { root: root.clone() });
        let thumbs = plan(&machine, CleanupItem::ThumbnailCaches).unwrap();
        assert_eq!(thumbs.linked, [root.join("home/mallory/.cache/thumbnails")]);
        let result = clean(&thumbs, SystemTime::now(), &mut |_| {});
        assert_eq!((result.files_removed, result.errors), (1, 1));
        assert!(root.join("etc/passwd").exists());
    }
}
