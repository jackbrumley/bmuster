//! Where releases come from (GitHub over HTTPS, bounded), and staging one
//! into `releases/<version>`: size and SHA-256 against the signed manifest,
//! then the archive rules, then its own VERSION.
use super::{archive, manifest};
use crate::layout::{bundle_version, check_bundle};
use crate::releases;
use anyhow::{bail, Context as _, Result};
use serde::Deserialize;
use sha2::{Digest as _, Sha256};
use std::io::{Read, Write as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

const REPOSITORY: &str = "jackbrumley/bmuster";
const MAX_RELEASE_JSON: u64 = 256 * 1024;

/// The releases an updater can install.
pub trait Source {
    /// The newest stable release's version.
    fn latest(&self) -> Result<String>;
    /// One asset of a release.
    fn open(&self, version: &str, asset: &str) -> Result<Box<dyn Read>>;
}

/// Reads at most `limit` bytes, failing when there are more.
pub fn read_limited(mut input: impl Read, limit: u64) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    input.by_ref().take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        bail!("the download is larger than {limit} bytes");
    }
    Ok(bytes)
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
        "https://github.com/{REPOSITORY}/releases/download/v{version}/{asset}"
    ))
}

#[derive(Deserialize)]
struct GitHubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

/// The version of GitHub's latest-release reply, refusing drafts and
/// pre-releases (test builds, SPEC-TEST-CHANNEL): the server installs only
/// stable releases.
fn stable_release_version(bytes: &[u8]) -> Result<String> {
    let release: GitHubRelease =
        serde_json::from_slice(bytes).context("GitHub's release reply is not understood")?;
    if release.draft || release.prerelease {
        bail!("GitHub returned a non-stable release");
    }
    let Some(version) = release.tag_name.strip_prefix('v') else {
        bail!("the latest release tag {} is not vX.Y.Z", release.tag_name);
    };
    manifest::version(version)?;
    Ok(version.to_string())
}

/// GitHub's latest release, over HTTPS only (the platform's certificate
/// check), with bounded sizes and times.
pub struct GitHub;

fn client(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .https_only(true)
        .max_redirects(5)
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_global(Some(timeout))
        .user_agent(concat!(
            "bmuster-server-updater/",
            env!("CARGO_PKG_VERSION")
        ))
        .build()
        .into()
}

impl Source for GitHub {
    fn latest(&self) -> Result<String> {
        let response = client(Duration::from_secs(60))
            .get(format!(
                "https://api.github.com/repos/{REPOSITORY}/releases/latest"
            ))
            .header("Accept", "application/vnd.github+json")
            .call()
            .context("could not ask GitHub for the latest release")?;
        let bytes = read_limited(response.into_body().into_reader(), MAX_RELEASE_JSON)?;
        stable_release_version(&bytes)
    }

    fn open(&self, version: &str, asset: &str) -> Result<Box<dyn Read>> {
        let url = asset_url(version, asset)?;
        let response = client(Duration::from_secs(30 * 60))
            .get(&url)
            .call()
            .with_context(|| format!("could not download {url}"))?;
        Ok(Box::new(response.into_body().into_reader()))
    }
}

/// Downloads, checks and unpacks a verified manifest's archive into
/// `releases/<version>`. A failure leaves no release folder behind.
pub fn stage(prefix: &Path, manifest: &manifest::Manifest, source: &dyn Source) -> Result<PathBuf> {
    let version = &manifest.version;
    std::fs::create_dir_all(releases::releases_dir(prefix))?;
    let target = releases::release_dir(prefix, version);
    let incoming = releases::incoming_dir(prefix, version);
    let download = releases::download_file(prefix, version);
    if releases::current_version(prefix)?.as_deref() == Some(version.as_str()) {
        bail!("{version} is already the running release");
    }
    for leftover in [&target, &incoming] {
        if leftover.exists() {
            std::fs::remove_dir_all(leftover)
                .with_context(|| format!("could not remove {}", leftover.display()))?;
        }
    }
    let result = (|| -> Result<()> {
        fetch_checked(&download, manifest, source)?;
        std::fs::create_dir(&incoming)?;
        archive::extract(std::fs::File::open(&download)?, &incoming)?;
        check_bundle(&incoming)?;
        if bundle_version(&incoming) != *version {
            bail!("the unpacked release's VERSION differs from its signed manifest");
        }
        let package: serde_json::Value =
            serde_json::from_slice(&std::fs::read(incoming.join("app/package.json"))?)?;
        if package.get("version").and_then(|v| v.as_str()) != Some(version.as_str()) {
            bail!("the application's package version differs from its signed manifest");
        }
        std::fs::rename(&incoming, &target)?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&download);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&incoming);
    }
    result?;
    Ok(target)
}

fn fetch_checked(path: &Path, manifest: &manifest::Manifest, source: &dyn Source) -> Result<()> {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(path)
        .with_context(|| format!("could not create {}", path.display()))?;
    let mut input = source.open(&manifest.version, &manifest.archive)?;
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
    if total != manifest.bytes || hex::encode(hash.finalize()) != manifest.sha256 {
        bail!("Server update hash or size does not match its signed manifest");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn asset_paths_cannot_escape_the_release() {
        assert!(super::asset_url("../latest", "archive").is_err());
        assert!(super::asset_url("0.3.1", "https://evil/archive").is_err());
        assert!(super::asset_url("0.3.1", "../../x").is_err());
        assert!(
            super::asset_url("0.3.1", "bmuster-app-x86_64-unknown-linux-gnu.tar.gz")
                .unwrap()
                .starts_with("https://github.com/jackbrumley/bmuster/releases/download/v0.3.1/")
        );
    }

    /// SPEC-TEST-CHANNEL T7: a test build on GitHub never reaches the server,
    /// whether GitHub flags it or only its version says so.
    #[test]
    fn a_prerelease_is_never_the_latest_release() {
        let reply = |tag: &str, prerelease: bool| {
            format!(r#"{{"tag_name":"{tag}","draft":false,"prerelease":{prerelease}}}"#)
        };
        assert_eq!(
            super::stable_release_version(reply("v0.4.14", false).as_bytes()).unwrap(),
            "0.4.14"
        );
        assert!(super::stable_release_version(reply("v0.4.14-test.1", true).as_bytes()).is_err());
        assert!(super::stable_release_version(reply("v0.4.14-test.1", false).as_bytes()).is_err());
        assert!(super::stable_release_version(reply("v0.4.14", true).as_bytes()).is_err());
    }

    #[test]
    fn reading_stops_at_the_limit() {
        assert_eq!(super::read_limited(&b"abc"[..], 3).unwrap(), b"abc");
        assert!(super::read_limited(&b"abcd"[..], 3).is_err());
    }
}
