//! Copying bundles: a folder tree copied whole, and a folder swapped in for
//! another, so a failed copy never leaves half a server behind.

use anyhow::{bail, Context as _, Result};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

pub fn sibling(dir: &Path, suffix: &str) -> Result<PathBuf> {
    let Some(name) = dir.file_name() else {
        bail!("{} has no folder name", dir.display());
    };
    let mut name = OsString::from(name);
    name.push(suffix);
    Ok(dir.with_file_name(name))
}

/// Copies a folder tree; files keep their permissions, symbolic links stay
/// links (Unix).
pub fn copy_tree(from: &Path, to: &Path) -> Result<()> {
    fs::create_dir_all(to).with_context(|| format!("could not create {}", to.display()))?;
    for entry in fs::read_dir(from).with_context(|| format!("could not read {}", from.display()))? {
        let entry = entry?;
        let source = entry.path();
        let target = to.join(entry.file_name());
        let kind = entry.file_type()?;
        if kind.is_dir() {
            copy_tree(&source, &target)?;
        } else if kind.is_symlink() {
            copy_link(&source, &target)?;
        } else {
            fs::copy(&source, &target).with_context(|| {
                format!(
                    "could not copy {} to {}",
                    source.display(),
                    target.display()
                )
            })?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn copy_link(source: &Path, target: &Path) -> Result<()> {
    let points_to = fs::read_link(source)?;
    std::os::unix::fs::symlink(points_to, target)
        .with_context(|| format!("could not link {}", target.display()))
}

#[cfg(not(unix))]
fn copy_link(source: &Path, _target: &Path) -> Result<()> {
    bail!("{} is a link; bundles hold none", source.display())
}

pub fn same_folder(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Puts the finished folder `staged` where `target` is: the old one moved
/// to `<target>.old`, the new one moved in, the old one deleted.
pub fn swap_in(staged: &Path, target: &Path) -> Result<()> {
    let old = sibling(target, ".old")?;
    if old.exists() {
        fs::remove_dir_all(&old).with_context(|| format!("could not remove {}", old.display()))?;
    }
    if target.exists() {
        fs::rename(target, &old)
            .with_context(|| format!("could not move {} to {}", target.display(), old.display()))?;
    }
    fs::rename(staged, target)
        .with_context(|| format!("could not move {} into place", staged.display()))?;
    if old.exists() {
        fs::remove_dir_all(&old).with_context(|| format!("could not remove {}", old.display()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::tests::{fake_bundle, scratch};

    #[test]
    fn a_staged_folder_replaces_the_old_one_completely() {
        let root = scratch("bundle-swap");
        let source = fake_bundle(&root);
        let target = root.join("opt").join("bmuster-server");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("left-over.txt"), "old").unwrap();
        let staged = sibling(&target, ".new").unwrap();
        copy_tree(&source, &staged).unwrap();

        swap_in(&staged, &target).unwrap();
        assert!(!target.join("left-over.txt").exists());
        assert_eq!(
            fs::read_to_string(target.join("VERSION")).unwrap(),
            "1.2.3\n"
        );
        assert!(!root.join("opt").join("bmuster-server.new").exists());
        assert!(!root.join("opt").join("bmuster-server.old").exists());
        assert!(same_folder(&target, &target));
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn executables_stay_executable_and_links_stay_links() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = scratch("bundle-modes");
        let source = fake_bundle(&root);
        let node = source.join("node").join("bin").join("node");
        fs::set_permissions(&node, fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink("server.js", source.join("app").join("link.js")).unwrap();
        let program = root.join("program");

        copy_tree(&source, &program).unwrap();
        let mode = fs::metadata(program.join("node").join("bin").join("node"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
        assert_eq!(
            fs::read_link(program.join("app").join("link.js")).unwrap(),
            Path::new("server.js")
        );
        fs::remove_dir_all(&root).unwrap();
    }
}
