//! The signed release manifest (`bmuster-app-<target>.json`): what one
//! target's whole-install bundle is, signed with the offline release key.
//! Archive names are derived, never supplied by a client.
use anyhow::{bail, Context as _, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

pub const DOMAIN: &[u8] = b"BMUSTER-SERVER-UPDATE-1\n";
pub const MAX_ARCHIVE: u64 = 1024 * 1024 * 1024;
pub const MAX_MANIFEST: u64 = 32 * 1024;

/// Field names are the release contract that installed servers (v0.3.x
/// included) already read, so they stay as they are.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u8,
    pub version: String,
    pub target: String,
    pub archive: String,
    pub bytes: u64,
    pub sha256: String,
    /// The oldest installed version whose updater may install this release
    /// by itself; older installs re-run the installer once.
    pub minimum_launcher: String,
    pub node_major: u32,
    /// Installed versions that can run on the database this release leaves
    /// behind (tested in the release workflow): automatic rollback to them.
    pub rollback_from: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub payload: String,
    pub signature: String,
}

pub fn manifest_name(target: &str) -> String {
    format!("bmuster-app-{target}.json")
}

pub fn archive_name(target: &str) -> String {
    format!("bmuster-app-{target}.tar.gz")
}

/// A stable release version (no pre-release or build part).
pub fn version(value: &str) -> Result<semver::Version> {
    let parsed = semver::Version::parse(value)?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() {
        bail!("Only stable release versions can be installed automatically");
    }
    Ok(parsed)
}

impl Manifest {
    /// Whether `installed` may run on the database this release leaves.
    pub fn rolls_back_to(&self, installed: &str) -> bool {
        self.rollback_from.iter().any(|v| v == installed)
    }
}

/// Checks the signature with one of `keys` (compiled in), then the target,
/// a newer version than `installed`, the updater version and the archive's
/// metadata. Anything wrong refuses the release.
pub fn verify(
    bytes: &[u8],
    keys: &[VerifyingKey],
    target: &str,
    installed: &str,
) -> Result<Manifest> {
    if bytes.len() as u64 > MAX_MANIFEST {
        bail!("Update manifest exceeds its size limit");
    }
    let envelope: Envelope = serde_json::from_slice(bytes)?;
    let payload = BASE64.decode(envelope.payload)?;
    let signature = Signature::from_slice(&BASE64.decode(envelope.signature)?)?;
    let mut message = DOMAIN.to_vec();
    message.extend_from_slice(&payload);
    if !keys
        .iter()
        .any(|key| key.verify_strict(&message, &signature).is_ok())
    {
        bail!("Server update signature is not from a trusted release key");
    }
    let manifest: Manifest =
        serde_json::from_slice(&payload).context("Server update manifest is damaged")?;
    if manifest.schema_version != 1 || manifest.target != target {
        bail!("Incompatible server update target or manifest schema");
    }
    if version(&manifest.version)? <= version(installed)? {
        bail!("Server update must be newer than the installed version");
    }
    if version(&manifest.minimum_launcher)? > version(installed)? {
        bail!("This release cannot update {installed} by itself; re-run the installer once");
    }
    if manifest.archive != archive_name(target)
        || manifest.bytes == 0
        || manifest.bytes > MAX_ARCHIVE
        || manifest.sha256.len() != 64
        || !manifest
            .sha256
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        bail!("Invalid server update archive metadata");
    }
    if manifest.rollback_from.len() > 32 {
        bail!("Invalid server update rollback list");
    }
    for item in &manifest.rollback_from {
        version(item)?;
    }
    Ok(manifest)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use ed25519_dalek::{Signer as _, SigningKey};

    pub fn signed(manifest: &Manifest, key: &SigningKey) -> Vec<u8> {
        let payload = serde_json::to_vec(manifest).unwrap();
        let mut message = DOMAIN.to_vec();
        message.extend_from_slice(&payload);
        serde_json::to_vec(&Envelope {
            payload: BASE64.encode(payload),
            signature: BASE64.encode(key.sign(&message).to_bytes()),
        })
        .unwrap()
    }

    pub fn manifest_for(version: &str, bytes: u64, sha256: &str, rollback: &[&str]) -> Manifest {
        Manifest {
            schema_version: 1,
            version: version.into(),
            target: env!("BMUSTER_TARGET").into(),
            archive: archive_name(env!("BMUSTER_TARGET")),
            bytes,
            sha256: sha256.into(),
            minimum_launcher: "0.4.0".into(),
            node_major: 26,
            rollback_from: rollback.iter().map(|v| v.to_string()).collect(),
        }
    }

    #[test]
    fn verification() {
        let key = SigningKey::from_bytes(&[11; 32]);
        let keys = [key.verifying_key()];
        let manifest = manifest_for("0.4.1", 10, &"a".repeat(64), &["0.4.0"]);
        let target = env!("BMUSTER_TARGET");
        let verify_one = |m: &Manifest| verify(&signed(m, &key), &keys, target, "0.4.0");
        let good = verify_one(&manifest).unwrap();
        assert!(good.rolls_back_to("0.4.0"));
        // No declared compatibility still installs; it only rules out rollback.
        let without = verify_one(&Manifest {
            rollback_from: vec![],
            ..manifest.clone()
        })
        .unwrap();
        assert!(!without.rolls_back_to("0.4.0"));
        for bad in [
            Manifest {
                target: "wrong".into(),
                ..manifest.clone()
            },
            Manifest {
                bytes: MAX_ARCHIVE + 1,
                ..manifest.clone()
            },
            Manifest {
                bytes: 0,
                ..manifest.clone()
            },
            Manifest {
                archive: "../../evil".into(),
                ..manifest.clone()
            },
            Manifest {
                sha256: "A".repeat(64),
                ..manifest.clone()
            },
            Manifest {
                minimum_launcher: "0.4.1".into(),
                ..manifest.clone()
            },
            // No downgrades and no reinstall of the same version.
            Manifest {
                version: "0.3.9".into(),
                ..manifest.clone()
            },
            Manifest {
                version: "0.4.0".into(),
                ..manifest.clone()
            },
            Manifest {
                version: "0.5.0-rc.1".into(),
                ..manifest.clone()
            },
            Manifest {
                schema_version: 2,
                ..manifest.clone()
            },
        ] {
            assert!(verify_one(&bad).is_err(), "{bad:?}");
        }
        // Another key, a changed payload, or no key at all: refused.
        let other = SigningKey::from_bytes(&[12; 32]);
        assert!(verify(&signed(&manifest, &other), &keys, target, "0.4.0").is_err());
        assert!(verify(&signed(&manifest, &key), &[], target, "0.4.0").is_err());
        let mut envelope: Envelope = serde_json::from_slice(&signed(&manifest, &key)).unwrap();
        let mut changed = manifest.clone();
        changed.sha256 = "b".repeat(64);
        envelope.payload = BASE64.encode(serde_json::to_vec(&changed).unwrap());
        assert!(verify(
            &serde_json::to_vec(&envelope).unwrap(),
            &keys,
            target,
            "0.4.0"
        )
        .is_err());
    }
}
