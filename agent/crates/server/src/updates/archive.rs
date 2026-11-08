//! Extract only ordinary application files into a fresh staging directory.
use anyhow::{bail, Context as _, Result};
use std::io::Read;
use std::path::{Component, Path};

const MAX_UNPACKED: u64 = 2 * 1024 * 1024 * 1024;

pub fn extract(input: impl Read, destination: &Path) -> Result<()> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(input));
    let mut total = 0u64;
    let mut count = 0;
    let mut paths = std::collections::HashSet::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        count += 1;
        if count > 100_000 {
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
        let mut components = path.components();
        let first = components.next().context("Empty archive path")?.as_os_str();
        if first != "app" && first != "releases" && path != Path::new("VERSION") {
            bail!("Unexpected file in application update");
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
        if entry.header().mode()? & 0o7000 != 0 {
            bail!("Special permission bits are forbidden in updates");
        }
        if !entry.unpack_in(destination)? {
            bail!("Archive file escaped staging");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let output = destination.join(path);
            let mode = entry.header().mode()? & 0o755;
            let mode = if kind.is_dir() {
                mode | 0o700
            } else {
                mode | 0o600
            };
            let mut permissions = std::fs::metadata(&output)?.permissions();
            permissions.set_mode(mode);
            std::fs::set_permissions(output, permissions)?;
        }
    }
    for needed in ["app/server.js", "app/package.json", "releases", "VERSION"] {
        if !destination.join(needed).exists() {
            bail!("Application update is missing {needed}");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn archive_rejects_links_and_unexpected_files() {
        for path in ["node/bin/node", "bmuster-server", "server.env"] {
            let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            let mut archive = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            header.set_mode(0o600);
            header.set_size(1);
            header.set_cksum();
            archive
                .append_data(&mut header, path, b"x".as_slice())
                .unwrap();
            let bytes = archive.into_inner().unwrap().finish().unwrap();
            let root = crate::layout::tests::scratch(&format!("unsafe-{}", path.replace('/', "-")));
            assert!(extract(bytes.as_slice(), &root).is_err());
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}
