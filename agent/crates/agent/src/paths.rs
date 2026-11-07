//! Where the agent keeps its files.

use anyhow::Result;
use std::path::PathBuf;

pub const KEY_FILE: &str = "agent.key";
pub const IDENTITY_FILE: &str = "identity.json";

/// `/var/lib/bmuster` on Linux, `C:\ProgramData\BMuster` on Windows.
pub fn default_data_dir() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        Ok(windows_dir("ProgramData")?.join("BMuster"))
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

/// A Windows known folder from its environment variable; never guessed.
#[cfg(windows)]
pub fn windows_dir(variable: &str) -> Result<PathBuf> {
    match std::env::var_os(variable) {
        Some(value) if !value.is_empty() => Ok(PathBuf::from(value)),
        _ => anyhow::bail!("the {variable} environment variable is not set"),
    }
}
