//! Where the agent keeps its files.

use anyhow::Result;
use std::path::PathBuf;

pub const KEY_FILE: &str = "agent.key";
pub const IDENTITY_FILE: &str = "identity.json";

/// Optional settings for the local page, e.g. `{ "listen": "0.0.0.0:47500" }`.
pub const LOCAL_PAGE_CONFIG_FILE: &str = "local-page.json";
/// The local page's sign-in secret (20 bytes, private).
pub const LOCAL_PAGE_SECRET_FILE: &str = "local-page.secret";
/// The machine id the secret was last reported to (so it is sent once per enrolment).
pub const LOCAL_PAGE_REPORTED_FILE: &str = "local-page.reported";
/// The local page's self-signed certificate (DER) and its private key (PKCS #8 DER, private).
pub const LOCAL_PAGE_CERT_FILE: &str = "local-page.crt";
pub const LOCAL_PAGE_KEY_FILE: &str = "local-page.key";
/// The people who may sign in to the local page with their own code, from
/// the server (private; SPEC-AGENT-LOCAL 7).
pub const LOCAL_USERS_FILE: &str = "local-users.json";
/// Local page events waiting to be sent to the server (private).
pub const LOCAL_EVENTS_FILE: &str = "local-events.json";

/// A move to another server enrols here first, with a fresh key.
pub const MOVE_STAGING_DIR: &str = "move-staging";
/// The staged enrolment once it worked: the commit point of a move. Its files
/// replace the identity, at once or at the next start after a crash.
pub const MOVE_PENDING_DIR: &str = "move-pending";

/// `/var/lib/bmuster` on Linux, `C:\ProgramData\BMuster` on Windows.
pub fn default_data_dir() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        Ok(bmuster_service::windows::known_folder("ProgramData")?.join("BMuster"))
    }
    #[cfg(not(windows))]
    {
        Ok(PathBuf::from("/var/lib/bmuster"))
    }
}

/// The data folder named on the command line, or the default.
pub fn data_dir(given: Option<PathBuf>) -> Result<PathBuf> {
    match given {
        Some(dir) => Ok(dir),
        None => default_data_dir(),
    }
}
