//! Agent updates (SPEC-AGENT-UPDATES): versions, signed releases, what the
//! server offers in a check-in reply and what the agent reports back.

use crate::sha256_hex;
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::fmt;

/// First line of every signed release message; bump it if the format changes.
pub const RELEASE_SIGNING_DOMAIN: &str = "BMUSTER-RELEASE-1";

/// The exact text a release key signs for one agent build. Binding the
/// version and target stops a server from passing off an older or foreign
/// build as the one on offer.
pub fn release_message(version: &str, target: &str, size: u64, sha256: &str) -> String {
    format!("{RELEASE_SIGNING_DOMAIN}\n{version}\n{target}\n{size}\n{sha256}")
}

/// The release message for a build's bytes.
pub fn release_message_of(version: &str, target: &str, bytes: &[u8]) -> String {
    release_message(version, target, bytes.len() as u64, &sha256_hex(bytes))
}

/// `GET` path of one agent build (public, like the install scripts' download).
pub fn release_path(version: &str, target: &str) -> String {
    format!("/agent/v1/releases/{version}/{target}")
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum PreRelease {
    Number(u64),
    Text(String),
}

/// A semantic version, `1.2.3` or `1.2.3-dev.20261107153000`. Build metadata
/// (`+…`) is refused: two different builds must never compare equal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentVersion {
    core: [u64; 3],
    pre: Vec<PreRelease>,
    text: String,
}

/// Why a version could not be read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionError(String);

impl fmt::Display for VersionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} is not a version like 1.2.3 or 1.2.3-dev.20261107153000",
            self.0
        )
    }
}

impl std::error::Error for VersionError {}

fn number(part: &str) -> Option<u64> {
    let digits = !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    let no_leading_zero = part == "0" || !part.starts_with('0');
    if digits && no_leading_zero {
        part.parse().ok()
    } else {
        None
    }
}

impl AgentVersion {
    pub fn parse(text: &str) -> Result<Self, VersionError> {
        let error = || VersionError(text.to_string());
        let (core_text, pre_text) = match text.split_once('-') {
            Some((core, pre)) => (core, Some(pre)),
            None => (text, None),
        };
        let parts: Vec<&str> = core_text.split('.').collect();
        let [major, minor, patch] = parts.as_slice() else {
            return Err(error());
        };
        let core = [
            number(major).ok_or_else(error)?,
            number(minor).ok_or_else(error)?,
            number(patch).ok_or_else(error)?,
        ];
        let mut pre = Vec::new();
        if let Some(pre_text) = pre_text {
            for id in pre_text.split('.') {
                if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                    return Err(error());
                }
                pre.push(match id.bytes().all(|b| b.is_ascii_digit()) {
                    true => PreRelease::Number(number(id).ok_or_else(error)?),
                    false => PreRelease::Text(id.to_string()),
                });
            }
        }
        Ok(Self {
            core,
            pre,
            text: text.to_string(),
        })
    }

    pub fn as_str(&self) -> &str {
        &self.text
    }
}

impl fmt::Display for AgentVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text)
    }
}

impl Ord for AgentVersion {
    /// Semantic Versioning 2.0.0 precedence: a pre-release sorts before its
    /// release; numeric identifiers compare as numbers and before text.
    fn cmp(&self, other: &Self) -> Ordering {
        self.core
            .cmp(&other.core)
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => {
                    for (left, right) in self.pre.iter().zip(&other.pre) {
                        let order = match (left, right) {
                            (PreRelease::Number(a), PreRelease::Number(b)) => a.cmp(b),
                            (PreRelease::Number(_), PreRelease::Text(_)) => Ordering::Less,
                            (PreRelease::Text(_), PreRelease::Number(_)) => Ordering::Greater,
                            (PreRelease::Text(a), PreRelease::Text(b)) => a.cmp(b),
                        };
                        if order != Ordering::Equal {
                            return order;
                        }
                    }
                    self.pre.len().cmp(&other.pre.len())
                }
            })
    }
}

impl PartialOrd for AgentVersion {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

// ---------------------------------------------------------------------------
// Check-in: what the server offers and what the agent reports
// ---------------------------------------------------------------------------

/// In a check-in reply: a newer signed build for this machine, or nothing.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum UpdateOffer {
    #[default]
    None,
    Offer {
        version: String,
        size: u64,
        /// Lower-case hex SHA-256 of the binary.
        sha256: String,
        /// Standard base64 Ed25519 signature over [`release_message`].
        signature: String,
    },
}

/// The last thing that happened to an update on this machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum UpdateEvent {
    None,
    /// The new version checked in within the health window and was kept.
    Updated {
        from: String,
        to: String,
        at_ms: i64,
    },
    /// The new version did not check in in time; the previous one runs again.
    RolledBack {
        version: String,
        reason: String,
        at_ms: i64,
    },
    /// The build was refused before switching (size, SHA-256 or signature).
    Refused {
        version: String,
        reason: String,
        at_ms: i64,
    },
}

/// In a check-in: whether this agent can update itself, and its last update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum UpdateReport {
    /// Started without the launcher (by hand, or installed before it existed):
    /// it cannot update itself. A one-time reinstall fixes that.
    NoLauncher,
    Launcher {
        last: UpdateEvent,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn v(text: &str) -> AgentVersion {
        AgentVersion::parse(text).unwrap()
    }

    #[test]
    fn versions_follow_semver_precedence() {
        let ordered = [
            "0.1.0-dev.20261107153000",
            "0.1.0-dev.20261107153001",
            "0.1.0",
            "0.1.1",
            "0.2.0-alpha",
            "0.2.0-alpha.1",
            "0.2.0-alpha.beta",
            "0.2.0-beta.2",
            "0.2.0-beta.11",
            "0.2.0",
            "1.0.0",
            "10.0.0",
        ];
        for pair in ordered.windows(2) {
            assert!(v(pair[0]) < v(pair[1]), "{} < {}", pair[0], pair[1]);
        }
        assert_eq!(v("1.2.3").cmp(&v("1.2.3")), Ordering::Equal);
        assert_eq!(v("0.1.0-dev.1").to_string(), "0.1.0-dev.1");
    }

    #[test]
    fn bad_versions_are_refused() {
        for bad in [
            "",
            "1",
            "1.2",
            "1.2.3.4",
            "01.2.3",
            "1.2.3-",
            "1.2.3-a..b",
            "1.2.3+build",
            "1.2.3-ä",
            "1.2.3-01",
            "../1.2.3",
            "v1.2.3",
        ] {
            assert!(AgentVersion::parse(bad).is_err(), "{bad} should be refused");
        }
    }

    #[test]
    fn release_messages_bind_version_target_size_and_hash() {
        assert_eq!(
            release_message("0.2.0", "x86_64-unknown-linux-gnu", 5, "ab"),
            "BMUSTER-RELEASE-1\n0.2.0\nx86_64-unknown-linux-gnu\n5\nab"
        );
        assert_eq!(
            release_message_of("0.2.0", "t", b""),
            "BMUSTER-RELEASE-1\n0.2.0\nt\n0\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            release_path("0.2.0", "x86_64-pc-windows-msvc"),
            "/agent/v1/releases/0.2.0/x86_64-pc-windows-msvc"
        );
    }

    #[test]
    fn update_shapes_match_the_server() {
        assert_eq!(
            serde_json::to_value(UpdateReport::Launcher {
                last: UpdateEvent::RolledBack {
                    version: "0.2.0".into(),
                    reason: "no check-in".into(),
                    at_ms: 5
                }
            })
            .unwrap(),
            json!({ "kind": "launcher", "last": {
                "kind": "rolled-back", "version": "0.2.0", "reason": "no check-in", "atMs": 5
            } })
        );
        assert_eq!(
            serde_json::to_value(UpdateReport::NoLauncher).unwrap(),
            json!({ "kind": "no-launcher" })
        );
        assert_eq!(
            serde_json::from_value::<UpdateOffer>(json!({
                "kind": "offer", "version": "0.2.0", "size": 3, "sha256": "ab", "signature": "c2ln"
            }))
            .unwrap(),
            UpdateOffer::Offer {
                version: "0.2.0".into(),
                size: 3,
                sha256: "ab".into(),
                signature: "c2ln".into()
            }
        );
        assert_eq!(
            serde_json::to_value(UpdateEvent::Updated {
                from: "0.1.0".into(),
                to: "0.2.0".into(),
                at_ms: 1
            })
            .unwrap(),
            json!({ "kind": "updated", "from": "0.1.0", "to": "0.2.0", "atMs": 1 })
        );
    }
}
