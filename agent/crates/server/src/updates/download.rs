//! Bounded HTTPS downloads and signature/hash checks before extraction.
use super::{archive, manifest};
use anyhow::{bail, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::VerifyingKey;
use sha2::{Digest as _, Sha256};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

fn client() -> ureq::Agent {
    ureq::Agent::config_builder()
        .https_only(true)
        .max_redirects(5)
        .timeout_connect(Some(std::time::Duration::from_secs(15)))
        .timeout_global(Some(std::time::Duration::from_secs(120)))
        .build()
        .into()
}

pub fn asset_url(version: &str, asset: &str) -> Result<String> {
    manifest::version(version)?;
    if asset.is_empty()
        || !asset
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_'))
    {
        bail!("Invalid release asset name");
    }
    Ok(format!(
        "https://github.com/jackbrumley/bmuster/releases/download/v{version}/{asset}"
    ))
}

pub fn stage(root: &Path, wanted: &str, current: &str) -> Result<PathBuf> {
    let target = env!("BMUSTER_TARGET");
    let key: [u8; 32] = BASE64
        .decode(include_str!("../../../agent/release-key.pub").trim())?
        .try_into()
        .map_err(|_| anyhow::anyhow!("Invalid compiled release key"))?;
    let key = VerifyingKey::from_bytes(&key)?;
    let mut response = client()
        .get(asset_url(wanted, &format!("bmuster-app-{target}.json"))?)
        .call()?;
    let mut bytes = Vec::new();
    response
        .body_mut()
        .as_reader()
        .take(32 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    let manifest = manifest::verify(&bytes, &key, target, current, env!("CARGO_PKG_VERSION"))?;
    if manifest.version != wanted {
        bail!("Update manifest names a different version");
    }
    let incoming = root.join("incoming");
    let versions = root.join("versions");
    let destination = versions.join(wanted);
    if destination.exists() {
        bail!("This application version is already staged; it was left intact");
    }
    match std::fs::symlink_metadata(&incoming) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            std::fs::remove_dir_all(&incoming)?;
        }
        Ok(_) => bail!("The server update staging path is not a regular directory"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    std::fs::create_dir(&incoming)?;
    let result = (|| -> Result<()> {
        stage_checked(&incoming, &manifest)?;
        std::fs::write(incoming.join("verified-manifest.json"), bytes)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&incoming);
    }
    result?;
    std::fs::create_dir_all(&versions)?;
    std::fs::rename(&incoming, &destination)?;
    Ok(destination)
}

fn stage_checked(incoming: &Path, manifest: &manifest::Manifest) -> Result<()> {
    let archive_path = incoming.join("archive.tar.gz");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&archive_path)?;
    let mut response = client()
        .get(asset_url(&manifest.version, &manifest.archive)?)
        .call()?;
    let mut input = response.body_mut().as_reader();
    let mut total = 0;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > manifest.bytes {
            bail!("Server update exceeds its signed size");
        }
        hash.update(&buffer[..count]);
        file.write_all(&buffer[..count])?;
    }
    file.sync_all()?;
    drop(file);
    if total != manifest.bytes || hex::encode(hash.finalize()) != manifest.sha256 {
        bail!("Server update hash or size does not match its signed manifest");
    }
    archive::extract(std::fs::File::open(&archive_path)?, incoming)?;
    std::fs::remove_file(archive_path)?;
    let version = std::fs::read_to_string(incoming.join("VERSION"))?;
    if version.trim() != manifest.version {
        bail!("The staged application's version differs from its signed manifest");
    }
    let package: serde_json::Value =
        serde_json::from_slice(&std::fs::read(incoming.join("app/package.json"))?)?;
    if package.get("version").and_then(|v| v.as_str()) != Some(&manifest.version) {
        bail!("The application's package version differs from its signed manifest");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn asset_paths_cannot_escape_the_release() {
        assert!(super::asset_url("../latest", "archive").is_err());
        assert!(super::asset_url("0.3.1", "https://evil/archive").is_err());
        assert!(
            super::asset_url("0.3.1", "bmuster-app-x86_64-unknown-linux-gnu.tar.gz")
                .unwrap()
                .starts_with("https://github.com/jackbrumley/bmuster/releases/download/v0.3.1/")
        );
    }
}
