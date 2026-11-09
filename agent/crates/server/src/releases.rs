//! The program folder's releases (SPEC-SERVER-UPDATES): one unpacked bundle
//! per version under `releases/`, and `current`, a link to the one that
//! runs. Only root or Administrators can write here; the installer and the
//! updater are the only writers.

use crate::bundle;
use crate::layout::{bundle_version, check_bundle};
use anyhow::{bail, Context as _, Result};
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

pub const RELEASES: &str = "releases";
pub const CURRENT: &str = "current";
/// Suffixes of a release still being written or being replaced.
const INCOMING: &str = ".incoming";
const DOWNLOAD: &str = ".download";
const OLD: &str = ".old";

/// A release folder name: a semantic version, so never a path.
pub fn checked_version(text: &str) -> Result<semver::Version> {
    semver::Version::parse(text).with_context(|| format!("{text:?} is not a release version"))
}

pub fn releases_dir(prefix: &Path) -> PathBuf {
    prefix.join(RELEASES)
}

pub fn release_dir(prefix: &Path, version: &str) -> PathBuf {
    releases_dir(prefix).join(version)
}

/// Where a release is unpacked before it is renamed into place.
pub fn incoming_dir(prefix: &Path, version: &str) -> PathBuf {
    releases_dir(prefix).join(format!("{version}{INCOMING}"))
}

/// Where a release archive is downloaded before it is unpacked.
pub fn download_file(prefix: &Path, version: &str) -> PathBuf {
    releases_dir(prefix).join(format!("{version}{DOWNLOAD}"))
}

/// The version `current` points at; `None` when there is no link.
pub fn current_version(prefix: &Path) -> Result<Option<String>> {
    let link = prefix.join(CURRENT);
    let target = match fs::read_link(&link) {
        Ok(target) => target,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(e).with_context(|| format!("{} is not a link to a release", link.display()))
        }
    };
    let Some(name) = target.file_name().and_then(OsStr::to_str) else {
        bail!("{} points at {}", link.display(), target.display());
    };
    checked_version(name)?;
    Ok(Some(name.to_string()))
}

/// Points `current` at `releases/<version>`, replacing the link in one
/// rename on Unix. Doing it again changes nothing, so every step that uses
/// it can be repeated after an interruption.
pub fn point_current(prefix: &Path, version: &str) -> Result<()> {
    checked_version(version)?;
    let release = release_dir(prefix, version);
    let metadata = fs::symlink_metadata(&release)
        .with_context(|| format!("there is no release {}", release.display()))?;
    if !metadata.is_dir() {
        bail!("{} is not a release folder", release.display());
    }
    check_bundle(&release)?;
    let link = prefix.join(CURRENT);
    let staged = prefix.join(format!("{CURRENT}.new"));
    remove_link(&staged)?;
    link_to(&release, &Path::new(RELEASES).join(version), &staged)?;
    swap_link(&staged, &link)?;
    sync_dir(prefix)
}

#[cfg(unix)]
fn link_to(_absolute: &Path, relative: &Path, link: &Path) -> Result<()> {
    std::os::unix::fs::symlink(relative, link)
        .with_context(|| format!("could not create the link {}", link.display()))
}

#[cfg(windows)]
fn link_to(absolute: &Path, _relative: &Path, link: &Path) -> Result<()> {
    std::os::windows::fs::symlink_dir(absolute, link)
        .with_context(|| format!("could not create the link {}", link.display()))
}

/// Unix: rename replaces the old link atomically. Windows cannot rename over
/// a directory link, so the old one goes first; the switch record covers
/// the moment without one.
fn swap_link(staged: &Path, link: &Path) -> Result<()> {
    #[cfg(windows)]
    remove_link(link)?;
    fs::rename(staged, link)
        .with_context(|| format!("could not move {} to {}", staged.display(), link.display()))
}

/// Removes a link (never what it points at); nothing when there is none.
fn remove_link(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
        Ok(metadata) if metadata.file_type().is_symlink() => {
            // A directory link on Windows is removed as a directory.
            #[cfg(windows)]
            let removed = fs::remove_dir(path).or_else(|_| fs::remove_file(path));
            #[cfg(not(windows))]
            let removed = fs::remove_file(path);
            removed.with_context(|| format!("could not remove the link {}", path.display()))
        }
        Ok(_) => bail!("{} is not a link; it was left alone", path.display()),
    }
}

#[cfg(unix)]
fn sync_dir(dir: &Path) -> Result<()> {
    fs::File::open(dir)
        .and_then(|folder| folder.sync_all())
        .with_context(|| format!("could not sync {}", dir.display()))
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> Result<()> {
    Ok(())
}

/// Deletes every release and leftover except the versions in `keep`.
pub fn prune(prefix: &Path, keep: &[&str]) -> Result<Vec<String>> {
    let dir = releases_dir(prefix);
    let mut removed = Vec::new();
    for entry in fs::read_dir(&dir).with_context(|| format!("could not read {}", dir.display()))? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if keep.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        }
        .with_context(|| format!("could not remove {}", path.display()))?;
        removed.push(name);
    }
    removed.sort();
    Ok(removed)
}

/// Copies an unpacked bundle to `releases/<version>` (the installer): beside
/// it first, then renamed in, so a failed copy never leaves half a release.
/// Nothing is copied when `source` already is that folder.
pub fn place(source: &Path, prefix: &Path, version: &str) -> Result<()> {
    checked_version(version)?;
    let target = release_dir(prefix, version);
    if bundle::same_folder(source, &target) {
        return Ok(());
    }
    if bundle_version(source) != version {
        bail!("{} is not version {version}", source.display());
    }
    fs::create_dir_all(releases_dir(prefix))?;
    let incoming = incoming_dir(prefix, version);
    let old = releases_dir(prefix).join(format!("{version}{OLD}"));
    for leftover in [&incoming, &old] {
        if leftover.exists() {
            fs::remove_dir_all(leftover)
                .with_context(|| format!("could not remove {}", leftover.display()))?;
        }
    }
    bundle::copy_tree(source, &incoming)?;
    if target.exists() {
        fs::rename(&target, &old)
            .with_context(|| format!("could not move {} aside", target.display()))?;
    }
    fs::rename(&incoming, &target)
        .with_context(|| format!("could not move {} into place", incoming.display()))?;
    if old.exists() {
        fs::remove_dir_all(&old).with_context(|| format!("could not remove {}", old.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::tests::{fake_bundle_named, scratch};

    #[test]
    fn current_moves_between_releases_and_pruning_keeps_what_is_asked() {
        let root = scratch("releases-point");
        let prefix = root.join("opt");
        for version in ["1.0.0", "1.1.0", "1.2.0"] {
            let bundle = fake_bundle_named(&root, &format!("bundle-{version}"), version);
            place(&bundle, &prefix, version).unwrap();
        }
        assert_eq!(current_version(&prefix).unwrap(), None);
        point_current(&prefix, "1.1.0").unwrap();
        assert_eq!(current_version(&prefix).unwrap().as_deref(), Some("1.1.0"));
        point_current(&prefix, "1.2.0").unwrap();
        point_current(&prefix, "1.2.0").unwrap();
        assert_eq!(current_version(&prefix).unwrap().as_deref(), Some("1.2.0"));
        assert_eq!(bundle_version(&prefix.join(CURRENT)), "1.2.0");
        // A release that is not there, or not a version, is never pointed at.
        assert!(point_current(&prefix, "9.9.9").is_err());
        assert!(point_current(&prefix, "../etc").is_err());
        assert_eq!(current_version(&prefix).unwrap().as_deref(), Some("1.2.0"));

        fs::write(download_file(&prefix, "2.0.0"), b"partial").unwrap();
        let removed = prune(&prefix, &["1.2.0", "1.1.0"]).unwrap();
        assert_eq!(removed, ["1.0.0", "2.0.0.download"]);
        assert!(release_dir(&prefix, "1.1.0").exists());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn placing_a_release_again_replaces_it_whole() {
        let root = scratch("releases-place");
        let prefix = root.join("opt");
        let bundle = fake_bundle_named(&root, "bundle", "1.0.0");
        place(&bundle, &prefix, "1.0.0").unwrap();
        fs::write(release_dir(&prefix, "1.0.0").join("stray"), b"x").unwrap();
        place(&bundle, &prefix, "1.0.0").unwrap();
        assert!(!release_dir(&prefix, "1.0.0").join("stray").exists());
        // From the release folder itself: nothing to copy.
        place(&release_dir(&prefix, "1.0.0"), &prefix, "1.0.0").unwrap();
        // A bundle whose VERSION says otherwise is refused.
        assert!(place(&bundle, &prefix, "1.0.1").is_err());
        fs::remove_dir_all(&root).unwrap();
    }
}
