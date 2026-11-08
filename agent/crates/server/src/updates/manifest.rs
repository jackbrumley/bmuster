//! Signed update metadata; archive URLs are derived, never supplied by a client.
use anyhow::{bail, Context as _, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

pub const DOMAIN: &[u8] = b"BMUSTER-SERVER-UPDATE-1\n";
pub const MAX_ARCHIVE: u64 = 1024 * 1024 * 1024;
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema_version: u8,
    pub version: String,
    pub target: String,
    pub archive: String,
    pub bytes: u64,
    pub sha256: String,
    pub minimum_launcher: String,
    pub node_major: u32,
    pub rollback_from: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub payload: String,
    pub signature: String,
}

pub fn version(value: &str) -> Result<semver::Version> {
    let parsed = semver::Version::parse(value)?;
    if !parsed.pre.is_empty() || !parsed.build.is_empty() {
        bail!("Only stable release versions can be installed automatically");
    }
    Ok(parsed)
}

pub fn verify(
    bytes: &[u8],
    key: &VerifyingKey,
    target: &str,
    current: &str,
    launcher: &str,
) -> Result<Manifest> {
    if bytes.len() > 32 * 1024 {
        bail!("Update manifest exceeds its size limit");
    }
    let envelope: Envelope = serde_json::from_slice(bytes)?;
    let payload = BASE64.decode(envelope.payload)?;
    let signature = Signature::from_slice(&BASE64.decode(envelope.signature)?)?;
    let mut message = DOMAIN.to_vec();
    message.extend_from_slice(&payload);
    key.verify_strict(&message, &signature)
        .context("Server update signature is not trusted")?;
    let manifest: Manifest = serde_json::from_slice(&payload)?;
    if manifest.schema_version != 1 || manifest.target != target || manifest.node_major != 26 {
        bail!("Incompatible server update target, schema or Node runtime");
    }
    if version(&manifest.version)? <= version(current)? {
        bail!("Server update must be newer than the running version");
    }
    if version(&manifest.minimum_launcher)? > version(launcher)? {
        bail!("This release requires the administrator installer to upgrade the launcher");
    }
    if manifest.archive != format!("bmuster-app-{target}.tar.gz")
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
    if manifest.rollback_from.len() > 32 || !manifest.rollback_from.iter().any(|v| v == current) {
        bail!("This release has no tested schema-compatible rollback to the running version; use the administrator installer");
    }
    for item in &manifest.rollback_from {
        version(item)?;
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer as _, SigningKey};
    fn signed(manifest: &Manifest, key: &SigningKey) -> Vec<u8> {
        let payload = serde_json::to_vec(manifest).unwrap();
        let mut message = DOMAIN.to_vec();
        message.extend_from_slice(&payload);
        serde_json::to_vec(&Envelope {
            payload: BASE64.encode(payload),
            signature: BASE64.encode(key.sign(&message).to_bytes()),
        })
        .unwrap()
    }
    #[test]
    fn verification() {
        let key = SigningKey::from_bytes(&[11; 32]);
        let manifest = Manifest {
            schema_version: 1,
            version: "0.3.1".into(),
            target: "x86_64-unknown-linux-gnu".into(),
            archive: "bmuster-app-x86_64-unknown-linux-gnu.tar.gz".into(),
            bytes: 10,
            sha256: "a".repeat(64),
            minimum_launcher: "0.3.0".into(),
            node_major: 26,
            rollback_from: vec!["0.3.0".into()],
        };
        let verify_one = |m: &Manifest| {
            verify(
                &signed(m, &key),
                &key.verifying_key(),
                &manifest.target,
                "0.3.0",
                "0.3.0",
            )
        };
        assert!(verify_one(&manifest).is_ok());
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
                archive: "../../evil".into(),
                ..manifest.clone()
            },
            Manifest {
                minimum_launcher: "99.0.0".into(),
                ..manifest.clone()
            },
            Manifest {
                rollback_from: vec![],
                ..manifest.clone()
            },
            Manifest {
                version: "0.2.0".into(),
                ..manifest.clone()
            },
        ] {
            assert!(verify_one(&bad).is_err());
        }
        assert!(verify(
            &signed(&manifest, &SigningKey::from_bytes(&[12; 32])),
            &key.verifying_key(),
            &manifest.target,
            "0.3.0",
            "0.3.0"
        )
        .is_err());
    }
}
