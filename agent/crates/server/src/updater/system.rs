//! What the updater drives on a real machine: the installed service, and
//! GitHub. Built with the `scratch-test` feature (never in a release) it can
//! use a folder of releases and a script for the service instead, so the
//! scratch install test runs without root; the signature checks are the
//! same either way.

use super::Service;
use crate::layout::{Layout, LAUNCHER};
use crate::updates::download::{GitHub, Source};
use anyhow::{bail, Context as _, Result};
use std::path::Path;
use std::process::Command;

/// The installed service: systemd on Linux, the service manager on Windows.
pub struct Installed<'a> {
    pub layout: &'a Layout,
}

impl Service for Installed<'_> {
    fn stop(&self) -> Result<()> {
        crate::platform::stop_service().map(|_| ())
    }

    fn start(&self) -> Result<()> {
        crate::platform::start_service()
    }

    fn refresh(&self, release: &Path) -> Result<()> {
        refresh_with(release, self.layout, false)
    }
}

/// Runs the release's own `install --refresh-units`, so a release can
/// change its service definitions without anyone re-running the installer.
fn refresh_with(release: &Path, layout: &Layout, no_service: bool) -> Result<()> {
    let launcher = release.join(LAUNCHER);
    let mut command = Command::new(&launcher);
    command
        .arg("install")
        .arg("--refresh-units")
        .arg("--prefix")
        .arg(&layout.program)
        .arg("--data-dir")
        .arg(&layout.data);
    if no_service {
        command.arg("--no-service");
    }
    let status = command
        .status()
        .with_context(|| format!("could not run {}", launcher.display()))?;
    if !status.success() {
        bail!(
            "{} install --refresh-units failed ({status})",
            launcher.display()
        );
    }
    Ok(())
}

/// The service and release source for this run.
pub fn service<'a>(layout: &'a Layout) -> Result<Box<dyn Service + 'a>> {
    #[cfg(feature = "scratch-test")]
    if let Some(script) = std::env::var_os("BMUSTER_UPDATE_TEST_SERVICE") {
        return Ok(Box::new(scratch::Script {
            layout,
            script: script.into(),
        }));
    }
    crate::platform::require_admin()?;
    if !crate::platform::service_installed() {
        bail!("the BMuster Server service is not installed, so there is nothing to update");
    }
    Ok(Box::new(Installed { layout }))
}

/// How long a new release has to report ready.
pub fn health_window() -> std::time::Duration {
    #[cfg(feature = "scratch-test")]
    if let Some(seconds) = std::env::var("BMUSTER_UPDATE_TEST_HEALTH_SECONDS")
        .ok()
        .and_then(|text| text.parse().ok())
    {
        return std::time::Duration::from_secs(seconds);
    }
    super::HEALTH_WINDOW
}

pub fn source() -> Box<dyn Source> {
    #[cfg(feature = "scratch-test")]
    if let Some(dir) = std::env::var_os("BMUSTER_UPDATE_TEST_SOURCE") {
        return Box::new(scratch::Folder { dir: dir.into() });
    }
    Box::new(GitHub)
}

#[cfg(feature = "scratch-test")]
mod scratch {
    use super::{refresh_with, Service, Source};
    use crate::layout::Layout;
    use anyhow::{bail, Context as _, Result};
    use std::io::Read;
    use std::path::{Path, PathBuf};

    /// `<dir>/latest` names the newest version; `<dir>/v<version>/<asset>`.
    pub struct Folder {
        pub dir: PathBuf,
    }

    impl Source for Folder {
        fn latest(&self) -> Result<String> {
            let text = std::fs::read_to_string(self.dir.join("latest"))?;
            Ok(text.trim().to_string())
        }
        fn open(&self, version: &str, asset: &str) -> Result<Box<dyn Read>> {
            crate::updates::download::asset_url(version, asset)?;
            let path = self.dir.join(format!("v{version}")).join(asset);
            Ok(Box::new(std::fs::File::open(&path).with_context(|| {
                format!("could not open {}", path.display())
            })?))
        }
    }

    /// A script run as `<script> stop` or `<script> start`.
    pub struct Script<'a> {
        pub layout: &'a Layout,
        pub script: PathBuf,
    }

    impl Script<'_> {
        fn run(&self, action: &str) -> Result<()> {
            let status = std::process::Command::new(&self.script)
                .arg(action)
                .status()?;
            if !status.success() {
                bail!("{} {action} failed ({status})", self.script.display());
            }
            Ok(())
        }
    }

    impl Service for Script<'_> {
        fn stop(&self) -> Result<()> {
            self.run("stop")
        }
        fn start(&self) -> Result<()> {
            self.run("start")
        }
        fn refresh(&self, release: &Path) -> Result<()> {
            refresh_with(release, self.layout, true)
        }
    }
}
