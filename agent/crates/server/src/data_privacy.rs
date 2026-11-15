//! The data folder holds `server.env` (with SECRETS_KEY), the database and
//! its snapshots, so only the server's own account and administrators may
//! open it (SPEC-SERVER-INSTALL I16).
//!
//! - Linux: the folder is `0700` and `server.env` `0600`, both owned by the
//!   service user. Install, every upgrade (`install --refresh-units`, run as
//!   root by the updater) and every start (`run`, as the owner) tighten
//!   whichever is looser.
//! - Windows: a protected DACL (nothing inherited from `C:\ProgramData`):
//!   SYSTEM and Administrators full control, LocalService (the service
//!   account) modify, and everything already inside reset to inherit just
//!   that. Install and every upgrade apply it (Administrator or SYSTEM);
//!   the service itself runs as LocalService, which may not change rules,
//!   so a start cannot.

use anyhow::Result;
use std::path::Path;

/// Install and upgrade: the full lockdown, as an administrator.
pub fn lock(data: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        bmuster_service::windows::restrict_dir(data, &crate::service_windows::data_grants())
    }
    #[cfg(unix)]
    {
        repair(data)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = data;
        Ok(())
    }
}

/// The mode to set when `mode` lets anyone but the owner in, else `None`.
#[cfg_attr(not(unix), allow(dead_code))]
fn tightened(mode: u32, private: u32) -> Option<u32> {
    (mode & 0o077 != 0).then_some(private)
}

/// Tightens the data folder to `0700` and `server.env` to `0600` when
/// either is looser, saying so; the owner may always do this.
#[cfg(unix)]
pub fn repair(data: &Path) -> Result<()> {
    use anyhow::Context as _;
    use std::fs;
    use std::os::unix::fs::PermissionsExt as _;

    for (path, private) in [
        (data.to_path_buf(), 0o700),
        (data.join(crate::layout::ENV_FILE), 0o600),
    ] {
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        let mode = metadata.permissions().mode() & 0o777;
        if let Some(wanted) = tightened(mode, private) {
            fs::set_permissions(&path, fs::Permissions::from_mode(wanted))
                .with_context(|| format!("could not make {} private", path.display()))?;
            eprintln!(
                "bmuster-server: {} was readable by others ({mode:o}); it is now {wanted:o}",
                path.display()
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_modes_open_to_others_are_tightened() {
        assert_eq!(tightened(0o700, 0o700), None);
        assert_eq!(tightened(0o600, 0o600), None);
        assert_eq!(tightened(0o400, 0o600), None);
        assert_eq!(tightened(0o755, 0o700), Some(0o700));
        assert_eq!(tightened(0o640, 0o600), Some(0o600));
        assert_eq!(tightened(0o604, 0o600), Some(0o600));
    }

    #[cfg(unix)]
    #[test]
    fn a_loose_data_folder_and_settings_file_are_made_private() {
        use std::fs;
        use std::os::unix::fs::PermissionsExt as _;
        let data = crate::layout::tests::scratch("data-privacy");
        let env_file = data.join(crate::layout::ENV_FILE);
        fs::write(&env_file, "SECRETS_KEY=x\n").unwrap();
        fs::set_permissions(&data, fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(&env_file, fs::Permissions::from_mode(0o644)).unwrap();

        lock(&data).unwrap();

        let mode =
            |path: &std::path::Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&data), 0o700);
        assert_eq!(mode(&env_file), 0o600);
        fs::remove_dir_all(&data).unwrap();
    }
}
