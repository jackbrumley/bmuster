//! `bmuster-server install` and `uninstall` (SPEC-SERVER-INSTALL,
//! SPEC-SERVER-UPDATES): the installer makes the same layout the updater
//! keeps, `releases/<version>` and `current`, from an unpacked bundle.

use crate::bundle;
use crate::layout::{self, bundle_version, check_bundle, Layout};
use crate::releases::{self, current_version, point_current, releases_dir, CURRENT};
use crate::updater::files;
use crate::{address, config, platform};
use anyhow::{bail, Context as _, Result};
use std::fs;
use std::path::Path;

/// What is in the program folder before an install.
#[derive(Debug, PartialEq, Eq)]
enum Program {
    /// Nothing, or an empty folder.
    Missing,
    /// `releases/` and `current` (this layout).
    Releases,
    /// A v0.3.x bundle copied straight into the folder.
    Version1,
}

fn program_kind(prefix: &Path) -> Result<Program> {
    if !prefix.exists() || fs::read_dir(prefix)?.next().is_none() {
        return Ok(Program::Missing);
    }
    if fs::symlink_metadata(prefix.join(CURRENT)).is_ok() && releases_dir(prefix).is_dir() {
        return Ok(Program::Releases);
    }
    if check_bundle(prefix).is_ok() {
        return Ok(Program::Version1);
    }
    bail!(
        "{} is not a BMuster server program folder, so it was left alone; choose another --prefix",
        prefix.display()
    )
}

/// Puts the bundle in `source` into `prefix` as `releases/<version>` and
/// points `current` at it, keeping the release that ran before and no
/// other. A v0.3.x program folder is replaced whole.
pub fn place_program(source: &Path, prefix: &Path) -> Result<String> {
    check_bundle(source)?;
    let version = bundle_version(source);
    releases::checked_version(&version)
        .with_context(|| format!("{} has no usable VERSION", source.display()))?;
    match program_kind(prefix)? {
        Program::Releases => {
            let before = current_version(prefix)?;
            releases::place(source, prefix, &version)?;
            point_current(prefix, &version)?;
            let mut keep = vec![version.as_str()];
            keep.extend(before.as_deref());
            releases::prune(prefix, &keep)?;
        }
        Program::Missing | Program::Version1 => {
            let staged = bundle::sibling(prefix, ".new")?;
            if staged.exists() {
                fs::remove_dir_all(&staged)
                    .with_context(|| format!("could not remove {}", staged.display()))?;
            }
            fs::create_dir_all(&staged)?;
            releases::place(source, &staged, &version)?;
            point_current(&staged, &version)?;
            if prefix.exists() && fs::read_dir(prefix)?.next().is_none() {
                fs::remove_dir(prefix)?;
            }
            bundle::swap_in(&staged, prefix)?;
        }
    }
    Ok(version)
}

/// Fails unless `prefix` holds an installed server, in either layout.
pub fn check_program(prefix: &Path) -> Result<()> {
    match program_kind(prefix)? {
        Program::Releases => check_bundle(&prefix.join(CURRENT)),
        Program::Version1 => Ok(()),
        Program::Missing => bail!("{} is empty", prefix.display()),
    }
}

pub fn install(target: &Layout, port: Option<u16>, no_service: bool) -> Result<()> {
    if !no_service {
        platform::require_admin()?;
    }
    let source = layout::own_dir()?;
    check_bundle(&source)?;
    if !no_service && platform::stop_service()? {
        println!("Stopped the running server for the upgrade.");
    }
    let version = place_program(&source, &target.program)?;
    // The installer is the source of truth: an update it interrupted is over.
    files::remove(&target.switch_record())?;
    println!(
        "Installed BMuster Server {version} in {}.",
        target.program.display()
    );

    fs::create_dir_all(&target.data)
        .with_context(|| format!("could not create {}", target.data.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&target.data, fs::Permissions::from_mode(0o700))?;
    }
    remove_version1_slots(target)?;
    if config::write_if_missing(&target.env_file(), port.unwrap_or(config::DEFAULT_PORT))? {
        println!("Wrote new settings to {}.", target.env_file().display());
    } else {
        println!("Kept the settings and data in {}.", target.data.display());
        let kept = config::read_listen(&target.env_file())?.port;
        if port.is_some_and(|wanted| wanted != kept) {
            println!(
                "Note: the server keeps port {kept}; change PORT in {} to move it.",
                target.env_file().display()
            );
        }
    }

    if no_service {
        println!(
            "No service was installed. Start the server with:\n  \"{}\" run --data-dir \"{}\"",
            target.launcher().display(),
            target.data.display()
        );
    } else {
        platform::install_service(target)?;
    }
    let listen = config::read_listen(&target.env_file())?;
    println!("Address: {}", address::best_url(listen));
    Ok(())
}

/// The v0.3.x launcher kept application slots in `<data>/server-updates`;
/// the whole install now lives in the program folder.
fn remove_version1_slots(target: &Layout) -> Result<()> {
    let slots = target.data.join("server-updates");
    match fs::symlink_metadata(&slots) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(&slots)
                .with_context(|| format!("could not remove {}", slots.display()))?;
            println!("Removed the old update slots in {}.", slots.display());
        }
        Ok(_) => files::remove(&slots)?,
        Err(_) => {}
    }
    Ok(())
}

pub fn refresh_units(target: &Layout, no_service: bool) -> Result<()> {
    if no_service {
        return Ok(());
    }
    platform::require_admin()?;
    platform::refresh_units(target)
}

pub fn uninstall(target: &Layout, purge: bool) -> Result<()> {
    if platform::service_installed() {
        platform::require_admin()?;
        platform::remove_service()?;
    }
    if target.program.exists() {
        check_program(&target.program)?;
        platform::remove_program(target)?;
        println!("Removed {}.", target.program.display());
    }
    if !target.data.exists() {
        return Ok(());
    }
    if !purge {
        println!(
            "Kept {} (database, settings and secrets key); add --purge to remove it.",
            target.data.display()
        );
        return Ok(());
    }
    if !target.env_file().exists() && !target.database().exists() {
        bail!(
            "{} has no server.env or bmuster.db, so it was left alone",
            target.data.display()
        );
    }
    fs::remove_dir_all(&target.data)
        .with_context(|| format!("could not remove {}", target.data.display()))?;
    println!(
        "Removed {} (database, settings and secrets key).",
        target.data.display()
    );
    platform::remove_user()
}

pub fn status(target: &Layout) {
    let running = current_version(&target.program)
        .ok()
        .flatten()
        .unwrap_or_else(|| "unknown".into());
    println!("Server version: {running}");
    println!("Program folder: {}", target.program.display());
    println!("Data folder:    {}", target.data.display());
    println!("Service:        {}", platform::service_state());
    match config::read_listen(&target.env_file()) {
        Ok(listen) => println!("Address:        {}", address::best_url(listen)),
        Err(e) => println!("Address:        unknown ({e:#})"),
    }
    match files::read_status(target) {
        Ok(Some(status)) => println!("Last update:    {}", status.message),
        Ok(None) => println!("Last update:    none yet"),
        Err(e) => println!("Last update:    unknown ({e:#})"),
    }
    println!("Log:            {}", platform::log_hint(target));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::tests::{fake_bundle_named, scratch};
    use crate::releases::release_dir;

    #[test]
    fn layout_and_units() {
        let root = scratch("install-layout");
        let prefix = root.join("opt").join("bmuster-server");

        // A fresh install: releases/<version> and current.
        let first = fake_bundle_named(&root, "first", "1.0.0");
        assert_eq!(place_program(&first, &prefix).unwrap(), "1.0.0");
        assert_eq!(current_version(&prefix).unwrap().as_deref(), Some("1.0.0"));
        check_program(&prefix).unwrap();
        assert!(!root.join("opt").join("bmuster-server.new").exists());

        // Newer installs keep the release before and prune the rest.
        for version in ["1.1.0", "1.2.0"] {
            let bundle = fake_bundle_named(&root, version, version);
            place_program(&bundle, &prefix).unwrap();
        }
        assert_eq!(current_version(&prefix).unwrap().as_deref(), Some("1.2.0"));
        assert!(release_dir(&prefix, "1.1.0").exists());
        assert!(!release_dir(&prefix, "1.0.0").exists());

        // Re-running the installer from the installed release changes nothing.
        place_program(&release_dir(&prefix, "1.2.0"), &prefix).unwrap();
        assert_eq!(current_version(&prefix).unwrap().as_deref(), Some("1.2.0"));

        // A v0.3.x folder (the bundle copied straight in) is replaced whole.
        let old = root.join("old-opt");
        bundle::copy_tree(&fake_bundle_named(&root, "v1", "0.3.3"), &old).unwrap();
        check_program(&old).unwrap();
        place_program(&first, &old).unwrap();
        assert_eq!(current_version(&old).unwrap().as_deref(), Some("1.0.0"));
        assert!(!old.join("app").exists());

        // Some other folder is never taken over.
        let other = root.join("other");
        fs::create_dir_all(&other).unwrap();
        fs::write(other.join("notes.txt"), b"mine").unwrap();
        assert!(place_program(&first, &other).is_err());
        assert!(check_program(&other).is_err());
        assert_eq!(fs::read(other.join("notes.txt")).unwrap(), b"mine");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn the_old_update_slots_are_removed_but_the_data_kept() {
        let root = scratch("install-v1-slots");
        let target = Layout {
            program: root.join("opt"),
            data: root.join("data"),
        };
        fs::create_dir_all(target.data.join("server-updates/versions/0.3.2")).unwrap();
        fs::write(target.database(), b"db").unwrap();
        remove_version1_slots(&target).unwrap();
        assert!(!target.data.join("server-updates").exists());
        assert_eq!(fs::read(target.database()).unwrap(), b"db");
        fs::remove_dir_all(&root).unwrap();
    }
}
