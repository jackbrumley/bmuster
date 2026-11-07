//! The machine's identity: its Ed25519 key, and what enrolment returned.

use crate::client::{Reply, Security, ServerUrl, TlsMode, Transport};
use crate::inventory;
use crate::paths::{IDENTITY_FILE, KEY_FILE};
use anyhow::{bail, Context as _, Result};
use bmuster_protocol::{
    decode_public_key, encode_public_key, CertificatePin, EnrolReply, EnrolRequest, ServerTrust,
    ENROL_PATH,
};
use ed25519_dalek::SigningKey;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write as _;
use std::path::Path;
use std::sync::Mutex;

/// Bounds on the check-in interval the server may set.
pub const MIN_CHECK_IN_SECONDS: u32 = 10;
pub const MAX_CHECK_IN_SECONDS: u32 = 86_400;

const CODE_ALPHABET: &str = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Identity {
    pub machine_id: String,
    pub server_url: String,
    pub server_public_key: String,
    pub check_in_seconds: u32,
    /// Local network mode: the only server certificate key this agent
    /// accepts. Absent: the system's trust store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_pin: Option<CertificatePin>,
    /// A certificate change the server announced, not yet seen working.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_pin: Option<ServerTrust>,
}

impl Identity {
    /// How this agent checks the server's certificate.
    pub fn server_trust(&self) -> ServerTrust {
        match self.server_pin {
            Some(pin) => ServerTrust::Pin { pin },
            None => ServerTrust::Public,
        }
    }

    pub fn set_server_trust(&mut self, current: ServerTrust, next: Option<ServerTrust>) {
        self.server_pin = match current {
            ServerTrust::Pin { pin } => Some(pin),
            ServerTrust::Public => None,
        };
        self.next_pin = next;
    }
}

pub fn check_interval(seconds: u32) -> Result<u32> {
    if !(MIN_CHECK_IN_SECONDS..=MAX_CHECK_IN_SECONDS).contains(&seconds) {
        bail!(
            "the server asked for a check-in every {seconds} s; \
             allowed is {MIN_CHECK_IN_SECONDS} to {MAX_CHECK_IN_SECONDS} s"
        );
    }
    Ok(seconds)
}

/// `k7p4qx29m`, `K7P-4QX-29M` → `K7P-4QX-29M`.
pub fn normalise_code(code: &str) -> Result<String> {
    let compact: String = code
        .chars()
        .filter(|c| *c != '-' && !c.is_whitespace())
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if compact.chars().count() != 9 || !compact.chars().all(|c| CODE_ALPHABET.contains(c)) {
        bail!("the join code must be 9 letters and digits, like K7P-4QX-29M");
    }
    Ok(format!(
        "{}-{}-{}",
        &compact[0..3],
        &compact[3..6],
        &compact[6..9]
    ))
}

/// Creates the data folder; on Unix only its owner may enter it.
pub fn prepare_data_dir(dir: &Path) -> Result<()> {
    fs::create_dir_all(dir).with_context(|| format!("could not create {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
            .with_context(|| format!("could not restrict {}", dir.display()))?;
    }
    Ok(())
}

/// Writes a file only its owner can read, replacing any old copy atomically.
fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension("tmp");
    let _ = fs::remove_file(&temp);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .with_context(|| format!("could not create {}", temp.display()))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .with_context(|| format!("could not write {}", temp.display()))?;
    drop(file);
    fs::rename(&temp, path).with_context(|| format!("could not save {}", path.display()))
}

/// Refuses a private file others can read (Unix only; Windows relies on the
/// folder ACL set by `install`).
fn check_private(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = fs::metadata(path)
            .with_context(|| format!("could not read {}", path.display()))?
            .permissions()
            .mode();
        if mode & 0o077 != 0 {
            bail!(
                "{} can be read by other users (mode {:o}); run `chmod 600` on it",
                path.display(),
                mode & 0o777
            );
        }
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

pub fn load_key(dir: &Path) -> Result<SigningKey> {
    let path = dir.join(KEY_FILE);
    check_private(&path)?;
    let bytes = fs::read(&path).with_context(|| format!("could not read {}", path.display()))?;
    let seed: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow::anyhow!("{} is damaged (not 32 bytes)", path.display()))?;
    Ok(SigningKey::from_bytes(&seed))
}

/// The machine's key: the one already on disk, or a new one.
fn load_or_create_key(dir: &Path) -> Result<SigningKey> {
    let path = dir.join(KEY_FILE);
    if path.exists() {
        return load_key(dir);
    }
    let mut seed = [0u8; 32];
    getrandom::getrandom(&mut seed).context("could not get random bytes for the key")?;
    write_private(&path, &seed)?;
    log::info!("Made a new key pair in {}", path.display());
    Ok(SigningKey::from_bytes(&seed))
}

pub fn identity_path(dir: &Path) -> std::path::PathBuf {
    dir.join(IDENTITY_FILE)
}

pub fn is_enrolled(dir: &Path) -> bool {
    identity_path(dir).exists()
}

pub fn load(dir: &Path) -> Result<Identity> {
    let path = identity_path(dir);
    if !path.exists() {
        bail!(
            "this machine is not enrolled ({} is missing); run `bmuster-agent enrol` first",
            path.display()
        );
    }
    check_private(&path)?;
    let text =
        fs::read_to_string(&path).with_context(|| format!("could not read {}", path.display()))?;
    let identity: Identity =
        serde_json::from_str(&text).with_context(|| format!("{} is damaged", path.display()))?;
    ServerUrl::parse(&identity.server_url)
        .with_context(|| format!("{} has a bad serverUrl", path.display()))?;
    decode_public_key(&identity.server_public_key)
        .with_context(|| format!("{} has a bad serverPublicKey", path.display()))?;
    check_interval(identity.check_in_seconds)?;
    Ok(identity)
}

pub fn save(dir: &Path, identity: &Identity) -> Result<()> {
    let mut json = serde_json::to_vec_pretty(identity)?;
    json.push(b'\n');
    write_private(&identity_path(dir), &json)
}

/// Serialises read-change-write of identity.json between the check-in loop
/// (interval) and the live socket (certificate pins).
static UPDATES: Mutex<()> = Mutex::new(());

/// Changes identity.json in place and saves it.
pub fn update(dir: &Path, change: impl FnOnce(&mut Identity)) -> Result<Identity> {
    let _guard = UPDATES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut identity = load(dir)?;
    change(&mut identity);
    save(dir, &identity)?;
    Ok(identity)
}

pub struct EnrolOptions<'a> {
    pub url: &'a str,
    pub code: &'a str,
    pub name: Option<&'a str>,
    pub tls: TlsMode,
}

/// Joins the server with a join code and saves the identity it returns.
pub fn enrol(dir: &Path, options: &EnrolOptions<'_>) -> Result<Identity> {
    let server = ServerUrl::parse(options.url)?;
    let code = normalise_code(options.code)?;
    prepare_data_dir(dir)?;
    if is_enrolled(dir) {
        bail!(
            "this machine is already enrolled ({} exists). \
             Run `bmuster-agent uninstall --purge` first to enrol it again.",
            identity_path(dir).display()
        );
    }
    let key = load_or_create_key(dir)?;
    let hostname = inventory::hostname()?;
    let name = match options.name {
        Some(name) if !name.trim().is_empty() => name.trim().to_string(),
        Some(_) => bail!("--name must not be empty"),
        None => hostname.clone(),
    };
    let request = EnrolRequest {
        code,
        public_key: encode_public_key(&key.verifying_key()),
        hostname,
        name,
        os_family: std::env::consts::OS.to_string(),
        target: env!("BMUSTER_TARGET").to_string(),
        agent_version: env!("CARGO_PKG_VERSION").to_string(),
    };
    let body = serde_json::to_vec(&request)?;

    let transport = Transport::new(server.clone(), Security::once(options.tls));
    log::info!("Enrolling with {} as \"{}\"", server.base(), request.name);
    let reply: EnrolReply =
        match transport.exchange(|channel| channel.post(ENROL_PATH, &body, None, |_| {}))? {
            Reply::Ok(reply) => reply,
            Reply::Refused(refusal) => bail!(
                "the server refused enrolment: {} ({})",
                refusal.message,
                refusal.reason
            ),
        };
    if reply.machine_id.trim().is_empty() {
        bail!("the server's enrolment reply has an empty machineId");
    }
    decode_public_key(&reply.server_public_key)
        .context("the server's enrolment reply has a bad serverPublicKey")?;
    let mut identity = Identity {
        machine_id: reply.machine_id,
        server_url: server.base(),
        server_public_key: reply.server_public_key,
        check_in_seconds: check_interval(reply.check_in_seconds)?,
        server_pin: None,
        next_pin: None,
    };
    if let TlsMode::Checked(trust) = options.tls {
        identity.set_server_trust(trust, None);
    }
    save(dir, &identity)?;
    log::info!(
        "Enrolled as machine {}; identity saved in {}",
        identity.machine_id,
        dir.display()
    );
    Ok(identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_normalised() {
        assert_eq!(normalise_code("k7p4qx29m").unwrap(), "K7P-4QX-29M");
        assert_eq!(normalise_code(" K7P-4QX-29M ").unwrap(), "K7P-4QX-29M");
        assert!(normalise_code("K7P-4QX-29").is_err());
        assert!(
            normalise_code("K7P-4QX-29O").is_err(),
            "O is not in the alphabet"
        );
        assert!(normalise_code("K7P-4QX-29Ä").is_err());
    }

    #[test]
    fn identity_round_trips_privately() {
        let dir = tempfile::tempdir().unwrap();
        prepare_data_dir(dir.path()).unwrap();
        let identity = Identity {
            machine_id: "3f0c2b1a-0000-4000-8000-000000000001".into(),
            server_url: "https://example.com".into(),
            server_public_key: encode_public_key(&SigningKey::from_bytes(&[9; 32]).verifying_key()),
            check_in_seconds: 60,
            server_pin: None,
            next_pin: None,
        };
        save(dir.path(), &identity).unwrap();
        assert_eq!(load(dir.path()).unwrap(), identity);
        // Without a pin the file has no pin fields (as written before pinning existed).
        let text = fs::read_to_string(identity_path(dir.path())).unwrap();
        assert!(!text.contains("Pin"));

        let key = load_or_create_key(dir.path()).unwrap();
        assert_eq!(load_key(dir.path()).unwrap().to_bytes(), key.to_bytes());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let key_path = dir.path().join(KEY_FILE);
            assert_eq!(
                fs::metadata(&key_path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            fs::set_permissions(&key_path, fs::Permissions::from_mode(0o644)).unwrap();
            assert!(load_key(dir.path()).is_err());
        }
    }

    #[test]
    fn pins_are_stored_in_identity_json() {
        let dir = tempfile::tempdir().unwrap();
        prepare_data_dir(dir.path()).unwrap();
        let pin =
            CertificatePin::parse("sha256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=").unwrap();
        let mut identity = Identity {
            machine_id: "m".into(),
            server_url: "https://192.168.1.20:3000".into(),
            server_public_key: encode_public_key(&SigningKey::from_bytes(&[9; 32]).verifying_key()),
            check_in_seconds: 60,
            server_pin: None,
            next_pin: None,
        };
        identity.set_server_trust(ServerTrust::Pin { pin }, Some(ServerTrust::Public));
        save(dir.path(), &identity).unwrap();
        let json: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(identity_path(dir.path())).unwrap()).unwrap();
        assert_eq!(json["serverPin"], pin.to_string());
        assert_eq!(json["nextPin"], serde_json::json!({ "kind": "public" }));

        let updated = update(dir.path(), |identity| {
            identity.set_server_trust(ServerTrust::Public, None);
        })
        .unwrap();
        assert_eq!(updated.server_trust(), ServerTrust::Public);
        assert_eq!(load(dir.path()).unwrap(), updated);
    }

    #[test]
    fn interval_bounds() {
        assert!(check_interval(9).is_err());
        assert_eq!(check_interval(60).unwrap(), 60);
        assert!(check_interval(86_401).is_err());
    }
}
