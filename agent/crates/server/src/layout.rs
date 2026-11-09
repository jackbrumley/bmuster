//! Where an installed server keeps its program and its data
//! (SPEC-SERVER-INSTALL section 4, SPEC-SERVER-UPDATES), and what a release
//! bundle holds.
//!
//! ```text
//! /opt/bmuster-server/releases/<version>/   one unpacked bundle per release
//! /opt/bmuster-server/current               link to the running release
//! /opt/bmuster-server/update-switch.json    the updater's switch record (root)
//! /var/lib/bmuster-server/update-requested  the app's request (empty, ignored)
//! /var/lib/bmuster-server/update-status.json the updater's progress, for the app
//! ```

use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

/// The server's settings: SECRETS_KEY, HOST, PORT and anything the admin adds.
pub const ENV_FILE: &str = "server.env";
const DATABASE_FILE: &str = "bmuster.db";
/// The Windows service's log (Node's output); journald on Linux.
#[cfg_attr(not(windows), allow(dead_code))]
pub const LOG_FILE: &str = "server.log";
/// The server version the bundle was built from.
const VERSION_FILE: &str = "VERSION";

#[cfg(windows)]
pub const LAUNCHER: &str = "bmuster-server.exe";
#[cfg(not(windows))]
pub const LAUNCHER: &str = "bmuster-server";

/// A program folder (its releases and `current`) and a data folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Layout {
    pub program: PathBuf,
    pub data: PathBuf,
}

impl Layout {
    /// The launcher of the running release, as the service starts it.
    pub fn launcher(&self) -> PathBuf {
        self.program.join(crate::releases::CURRENT).join(LAUNCHER)
    }

    /// The updater's switch record: in the program folder, which only root
    /// or Administrators can write, because recovery acts on it.
    pub fn switch_record(&self) -> PathBuf {
        self.program.join("update-switch.json")
    }

    /// Held by the one updater that may run.
    pub fn update_lock(&self) -> PathBuf {
        self.program.join("update.lock")
    }

    /// The app's request for an update; only its existence counts.
    pub fn update_flag(&self) -> PathBuf {
        self.data.join("update-requested")
    }

    /// The updater's progress, which the app shows.
    pub fn update_status(&self) -> PathBuf {
        self.data.join("update-status.json")
    }

    /// Written by the app once it serves requests: nonce, version, process.
    pub fn ready_file(&self) -> PathBuf {
        self.data.join("ready.json")
    }

    pub fn backups(&self) -> PathBuf {
        self.data.join("backups")
    }

    pub fn env_file(&self) -> PathBuf {
        self.data.join(ENV_FILE)
    }

    pub fn database(&self) -> PathBuf {
        self.data.join(DATABASE_FILE)
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub fn log_file(&self) -> PathBuf {
        self.data.join(LOG_FILE)
    }
}

/// The bundled Node in a release folder.
pub fn node_in(program: &Path) -> PathBuf {
    if cfg!(windows) {
        program.join("node").join("node.exe")
    } else {
        program.join("node").join("bin").join("node")
    }
}

/// `/opt/bmuster-server`, or `C:\Program Files\BMuster Server`.
pub fn default_program_dir() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        Ok(bmuster_service::windows::known_folder("ProgramFiles")?.join("BMuster Server"))
    }
    #[cfg(not(windows))]
    {
        Ok(PathBuf::from("/opt/bmuster-server"))
    }
}

/// `/var/lib/bmuster-server`, or `C:\ProgramData\BMuster Server`.
pub fn default_data_dir() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        Ok(bmuster_service::windows::known_folder("ProgramData")?.join("BMuster Server"))
    }
    #[cfg(not(windows))]
    {
        Ok(PathBuf::from("/var/lib/bmuster-server"))
    }
}

/// The folders named on the command line, or the defaults.
pub fn resolve(program: Option<PathBuf>, data: Option<PathBuf>) -> Result<Layout> {
    Ok(Layout {
        program: match program {
            Some(dir) => dir,
            None => default_program_dir()?,
        },
        data: match data {
            Some(dir) => dir,
            None => default_data_dir()?,
        },
    })
}

/// The folder this launcher runs from: an unpacked bundle or a release folder.
pub fn own_dir() -> Result<PathBuf> {
    let exe = std::env::current_exe()?;
    match exe.parent() {
        Some(dir) => Ok(dir.to_path_buf()),
        None => bail!("could not find the folder of {}", exe.display()),
    }
}

/// Fails unless `dir` holds a server bundle (launcher, Node, app, agents),
/// so neither a copy nor a delete ever acts on some other folder.
pub fn check_bundle(dir: &Path) -> Result<()> {
    let needed = [
        dir.join(LAUNCHER),
        node_in(dir),
        dir.join("app").join("server.js"),
        dir.join("releases"),
    ];
    if let Some(missing) = needed.iter().find(|path| !path.exists()) {
        bail!(
            "{} is not a BMuster server bundle ({} is missing)",
            dir.display(),
            missing.display()
        );
    }
    Ok(())
}

/// The server version in a bundle's VERSION file.
pub fn bundle_version(dir: &Path) -> String {
    std::fs::read_to_string(dir.join(VERSION_FILE))
        .map(|text| text.trim().to_string())
        .unwrap_or_else(|_| "unknown".into())
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A minimal bundle under `root`, for the bundle and command tests.
    pub fn fake_bundle(root: &Path) -> PathBuf {
        fake_bundle_named(root, "bundle", "1.2.3")
    }

    /// A minimal bundle of `version` in `root/<name>`.
    pub fn fake_bundle_named(root: &Path, name: &str, version: &str) -> PathBuf {
        let dir = root.join(name);
        std::fs::create_dir_all(node_in(&dir).parent().unwrap()).unwrap();
        std::fs::create_dir_all(dir.join("app")).unwrap();
        std::fs::create_dir_all(dir.join("releases").join("0.1.0")).unwrap();
        std::fs::write(node_in(&dir), "node").unwrap();
        std::fs::write(dir.join("app").join("server.js"), "// server").unwrap();
        std::fs::write(dir.join(LAUNCHER), "launcher").unwrap();
        std::fs::write(dir.join(VERSION_FILE), format!("{version}\n")).unwrap();
        dir
    }

    #[test]
    fn a_bundle_needs_the_launcher_node_app_and_agents() {
        let root = scratch("layout-check");
        let dir = fake_bundle(&root);
        check_bundle(&dir).unwrap();
        assert_eq!(bundle_version(&dir), "1.2.3");
        std::fs::remove_file(dir.join("app").join("server.js")).unwrap();
        let error = check_bundle(&dir).unwrap_err().to_string();
        assert!(error.contains("is not a BMuster server bundle"), "{error}");
        assert!(check_bundle(&root).is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn data_and_program_paths() {
        let layout = Layout {
            program: PathBuf::from("/p"),
            data: PathBuf::from("/d"),
        };
        assert_eq!(layout.env_file(), Path::new("/d").join("server.env"));
        assert_eq!(layout.database(), Path::new("/d").join("bmuster.db"));
        assert_eq!(
            layout.update_flag(),
            Path::new("/d").join("update-requested")
        );
        assert_eq!(
            layout.update_status(),
            Path::new("/d").join("update-status.json")
        );
        assert_eq!(
            layout.switch_record(),
            Path::new("/p").join("update-switch.json")
        );
        assert_eq!(
            layout.launcher(),
            Path::new("/p").join("current").join(LAUNCHER)
        );
    }

    /// An empty folder for one test, under the system temp folder.
    pub fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("bmuster-server-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }
}
