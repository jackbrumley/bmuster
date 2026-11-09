//! Extract only the files a server bundle holds into a fresh release folder:
//! no traversal, links, special files or special permission bits.
use crate::layout::{node_in, LAUNCHER};
use anyhow::{bail, Context as _, Result};
use std::io::Read;
use std::path::{Component, Path};

const MAX_UNPACKED: u64 = 2 * 1024 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
/// The top level of a bundle (release-server.ts).
const TOP_LEVEL: [&str; 6] = [LAUNCHER, "node", "app", "releases", "VERSION", "LICENSE"];

pub fn extract(input: impl Read, destination: &Path) -> Result<()> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(input));
    let mut total = 0u64;
    let mut count = 0;
    let mut paths = std::collections::HashSet::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        count += 1;
        if count > MAX_ENTRIES {
            bail!("Too many files in the update archive");
        }
        let path = entry.path()?.into_owned();
        if !paths.insert(path.clone()) {
            bail!("Duplicate path in update archive");
        }
        if path.as_os_str().len() > 1024
            || path
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            bail!("Unsafe update archive path");
        }
        let first = path
            .components()
            .next()
            .context("Empty archive path")?
            .as_os_str();
        if !TOP_LEVEL.iter().any(|name| first == *name) {
            bail!("Unexpected file in server update: {}", path.display());
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            bail!("Links and special files are forbidden in updates");
        }
        total = total
            .checked_add(entry.size())
            .context("Archive size overflow")?;
        if total > MAX_UNPACKED {
            bail!("Update archive exceeds its unpacked size limit");
        }
        let mode = entry.header().mode()?;
        if mode & 0o7000 != 0 {
            bail!("Special permission bits are forbidden in updates");
        }
        if !entry.unpack_in(destination)? {
            bail!("Archive file escaped staging");
        }
        // Readable by the service account; executable only where it was.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let output = destination.join(&path);
            let mode = if kind.is_dir() || mode & 0o111 != 0 {
                0o755
            } else {
                0o644
            };
            std::fs::set_permissions(output, std::fs::Permissions::from_mode(mode))?;
        }
    }
    let needed = [
        destination.join(LAUNCHER),
        node_in(destination),
        destination.join("app/server.js"),
        destination.join("app/package.json"),
        destination.join("releases"),
        destination.join("VERSION"),
    ];
    if let Some(missing) = needed.iter().find(|path| !path.exists()) {
        bail!("Server update is missing {}", missing.display());
    }
    Ok(())
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// A gzip tar of `(path, bytes, mode)` entries.
    pub fn archive_of(entries: &[(&str, &[u8], u32)]) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut archive = tar::Builder::new(encoder);
        for (path, bytes, mode) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_mode(*mode);
            header.set_size(bytes.len() as u64);
            header.set_cksum();
            archive.append_data(&mut header, path, *bytes).unwrap();
        }
        archive.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn archive_rejects_links_and_unexpected_files() {
        for path in ["server.env", "etc/passwd", "bmuster.db"] {
            let bytes = archive_of(&[(path, b"x", 0o600)]);
            let root = crate::layout::tests::scratch(&format!("unsafe-{}", path.replace('/', "-")));
            assert!(extract(bytes.as_slice(), &root).is_err(), "{path}");
            std::fs::remove_dir_all(root).unwrap();
        }
        // A setuid file, even in an allowed folder.
        let bytes = archive_of(&[("app/server.js", b"x", 0o4755)]);
        let root = crate::layout::tests::scratch("unsafe-setuid");
        assert!(extract(bytes.as_slice(), &root).is_err());
        std::fs::remove_dir_all(root).unwrap();

        // A link entry.
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut archive = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Symlink);
        header.set_size(0);
        header.set_cksum();
        archive
            .append_link(&mut header, "app/server.js", "/etc/shadow")
            .unwrap();
        let bytes = archive.into_inner().unwrap().finish().unwrap();
        let root = crate::layout::tests::scratch("unsafe-link");
        assert!(extract(bytes.as_slice(), &root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_whole_bundle_unpacks_and_an_incomplete_one_does_not() {
        let node = if cfg!(windows) {
            "node/node.exe"
        } else {
            "node/bin/node"
        };
        let full: Vec<(&str, &[u8], u32)> = vec![
            (LAUNCHER, b"launcher", 0o755),
            (node, b"node", 0o755),
            ("app/server.js", b"//", 0o644),
            ("app/package.json", b"{}", 0o644),
            ("releases/0.4.0/x/bmuster-agent", b"agent", 0o755),
            ("VERSION", b"0.4.0\n", 0o644),
        ];
        let root = crate::layout::tests::scratch("archive-whole");
        extract(archive_of(&full).as_slice(), &root).unwrap();
        crate::layout::check_bundle(&root).unwrap();
        std::fs::remove_dir_all(&root).unwrap();

        let root = crate::layout::tests::scratch("archive-incomplete");
        assert!(extract(archive_of(&full[1..]).as_slice(), &root).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
