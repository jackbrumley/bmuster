//! Signed server releases (SPEC-SERVER-UPDATES): the manifest and its
//! signature, the archive rules, and where releases are downloaded from.
//! The updater (`updater/`) uses them; nothing else installs code.
pub mod archive;
pub mod download;
pub mod manifest;

use anyhow::{Context as _, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::VerifyingKey;

/// This build's target triple: releases for any other are refused.
pub const TARGET: &str = env!("BMUSTER_TARGET");

fn decode_key(source: &str, text: &str) -> Result<VerifyingKey> {
    let bytes: [u8; 32] = BASE64
        .decode(text.trim())
        .with_context(|| format!("{source} is not base64"))?
        .try_into()
        .map_err(|_| anyhow::anyhow!("{source} is not a 32-byte Ed25519 key"))?;
    VerifyingKey::from_bytes(&bytes).with_context(|| format!("{source} is not an Ed25519 key"))
}

/// The release keys compiled into this build: the project's
/// (`agent/crates/agent/release-key.pub`), plus `BMUSTER_EXTRA_RELEASE_KEY`
/// when it was set at build time (development builds and self-builders).
/// A damaged key fails the update; it never widens what is trusted.
pub fn trusted_keys() -> Result<Vec<VerifyingKey>> {
    let mut keys = vec![decode_key(
        "the compiled release key",
        include_str!("../../../agent/release-key.pub"),
    )?];
    let extra = env!("BMUSTER_EXTRA_RELEASE_KEY");
    if !extra.trim().is_empty() {
        keys.push(decode_key("BMUSTER_EXTRA_RELEASE_KEY", extra)?);
    }
    Ok(keys)
}

#[cfg(test)]
mod tests {
    #[test]
    fn this_build_trusts_the_project_release_key() {
        let keys = super::trusted_keys().unwrap();
        assert!(!keys.is_empty());
        assert!(super::decode_key("test", "not a key").is_err());
    }
}
