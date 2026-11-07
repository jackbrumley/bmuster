//! `server.env`: the server's settings, written once by `install` and kept
//! on upgrades. Node reads it (`--env-file`); the launcher reads only PORT
//! and the local network mode default, to print the address.

use anyhow::{bail, Context as _, Result};
use base64::Engine as _;
use std::io::Write as _;
use std::path::Path;

/// HTTPS port of a fresh install (SPEC-SERVER-INSTALL section 6).
pub const DEFAULT_PORT: u16 = 8443;

/// The settings of a fresh install: a new secrets key, every address on
/// `port`, and local network mode on until someone changes it in Settings.
pub fn new_config(secrets_key: &str, port: u16) -> String {
    format!(
        "\
# BMuster server settings. Written once by `bmuster-server install` and kept
# on upgrades. Edit, then restart the service. DATABASE_PATH and RELEASES_PATH
# are set by the launcher (the data and program folders), so leave them out.
# More settings: .env.example in https://github.com/jackbrumley/bmuster

# Encrypts secrets at rest. Back it up with bmuster.db; never share it.
SECRETS_KEY={secrets_key}

# Where to listen. Browsers and agents use https://<this machine>:{port}.
HOST=0.0.0.0
PORT={port}

# First start only (no users yet): serve HTTPS with the server's own
# certificate. After setup, change it in Settings > Security.
BMUSTER_LOCAL_NETWORK_MODE=on
"
    )
}

/// 32 random bytes in base64, like `openssl rand -base64 32`.
pub fn new_secrets_key() -> Result<String> {
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).context("could not make a secrets key")?;
    Ok(base64::engine::general_purpose::STANDARD.encode(key))
}

/// Writes a fresh `server.env` (private to its owner) unless one exists;
/// returns whether it wrote one.
pub fn write_if_missing(path: &Path, port: u16) -> Result<bool> {
    if path.exists() {
        return Ok(false);
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .with_context(|| format!("could not create {}", path.display()))?;
    file.write_all(new_config(&new_secrets_key()?, port).as_bytes())
        .with_context(|| format!("could not write {}", path.display()))?;
    Ok(true)
}

/// The last `KEY=value` for `key`, without surrounding quotes; comments and
/// other lines are skipped, as Node's `--env-file` does.
pub fn value(text: &str, key: &str) -> Option<String> {
    text.lines()
        .rev()
        .filter_map(|line| line.trim().split_once('='))
        .filter(|(name, _)| name.trim() == key)
        .map(|(_, value)| {
            let value = value.trim();
            let quoted = value.len() >= 2
                && (value.starts_with('"') && value.ends_with('"')
                    || value.starts_with('\'') && value.ends_with('\''));
            if quoted {
                value[1..value.len() - 1].to_string()
            } else {
                value.to_string()
            }
        })
        .next()
}

/// How the server listens, as far as `server.env` says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Listen {
    pub port: u16,
    /// Local network mode was asked for. Settings can turn it off later, so
    /// this is what a fresh install serves, not a promise.
    pub https: bool,
}

pub fn listen(text: &str) -> Result<Listen> {
    let port = match value(text, "PORT") {
        None => 3000, // server.ts's own default
        Some(port) => match port.parse() {
            Ok(port) => port,
            Err(_) => bail!(
                "PORT={port} in {} is not a port number",
                super::layout::ENV_FILE
            ),
        },
    };
    Ok(Listen {
        port,
        https: value(text, "BMUSTER_LOCAL_NETWORK_MODE").as_deref() == Some("on"),
    })
}

/// `listen` for the file at `path`.
pub fn read_listen(path: &Path) -> Result<Listen> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("could not read {}", path.display()))?;
    listen(&text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_config_has_a_key_the_port_and_local_network_mode() {
        let key = new_secrets_key().unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(&key)
            .unwrap();
        assert_eq!(decoded.len(), 32);
        assert_ne!(key, new_secrets_key().unwrap());

        let text = new_config(&key, 8443);
        assert_eq!(value(&text, "SECRETS_KEY"), Some(key));
        assert_eq!(value(&text, "HOST").as_deref(), Some("0.0.0.0"));
        assert_eq!(
            listen(&text).unwrap(),
            Listen {
                port: 8443,
                https: true
            }
        );
        assert_eq!(value(&text, "DATABASE_PATH"), None);
    }

    #[test]
    fn values_are_read_like_node_reads_them() {
        let text = "# PORT=1\nPORT = 9000\nORIGIN=\"https://a.example\"\nX='y'\nPORT=9001\n";
        assert_eq!(value(text, "PORT").as_deref(), Some("9001"));
        assert_eq!(value(text, "ORIGIN").as_deref(), Some("https://a.example"));
        assert_eq!(value(text, "X").as_deref(), Some("y"));
        assert_eq!(value(text, "MISSING"), None);
        assert_eq!(
            listen("BMUSTER_LOCAL_NETWORK_MODE=off").unwrap(),
            Listen {
                port: 3000,
                https: false
            }
        );
        assert!(listen("PORT=eighty").is_err());
    }

    #[test]
    fn an_existing_config_is_kept() {
        let dir = crate::layout::tests::scratch("config-keep");
        let path = dir.join("server.env");
        assert!(write_if_missing(&path, 47620).unwrap());
        let first = std::fs::read_to_string(&path).unwrap();
        assert!(!write_if_missing(&path, 8443).unwrap());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
        assert_eq!(read_listen(&path).unwrap().port, 47620);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
