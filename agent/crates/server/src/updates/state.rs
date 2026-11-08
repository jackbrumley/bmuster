//! A durable switch record makes interruption recover to the previous application.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct State {
    pub current: Option<String>,
    pub previous: Option<String>,
    pub pending: Option<String>,
    pub phase: String,
    pub message: String,
}
impl Default for State {
    fn default() -> Self {
        Self {
            current: None,
            previous: None,
            pending: None,
            phase: "idle".into(),
            message: String::new(),
        }
    }
}
impl State {
    pub fn load(path: &Path) -> Result<Self> {
        let state: Self = match super::read_small(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound) =>
            {
                Self::default()
            }
            Err(error) => return Err(error),
        };
        for item in [&state.current, &state.previous, &state.pending]
            .into_iter()
            .flatten()
        {
            super::manifest::version(item)?;
        }
        Ok(state)
    }
    pub fn recover(&mut self) {
        if self.pending.take().is_some() {
            self.current = self.previous.take();
            self.phase = "rolled-back".into();
            self.message = "An interrupted application switch was recovered to the previous version. The database was retained.".into();
        } else if matches!(self.phase.as_str(), "downloading" | "preparing") {
            self.phase = "failed".into();
            self.message = "The server stopped before switching applications. The installed version remains active.".into();
        }
    }
    pub fn save(&self, path: &Path) -> Result<()> {
        atomic(path, &serde_json::to_vec(self)?)
    }
}

pub fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write as _;
    let next = path.with_extension("new");
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&next)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt as _;
        let from: Vec<u16> = next.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(
                from.as_ptr(),
                to.as_ptr(),
                windows_sys::Win32::Storage::FileSystem::MOVEFILE_REPLACE_EXISTING
                    | windows_sys::Win32::Storage::FileSystem::MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(next, path)?;
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("State has no parent folder"))?;
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

pub fn validate_nonce(value: &str) -> Result<()> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("Invalid readiness nonce");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery() {
        let root = crate::layout::tests::scratch("update-state");
        let path = root.join("state.json");
        let mut state = State {
            current: Some("0.3.1".into()),
            previous: Some("0.3.0".into()),
            pending: Some("0.3.1".into()),
            phase: "starting".into(),
            message: String::new(),
        };
        state.save(&path).unwrap();
        state = State::load(&path).unwrap();
        state.recover();
        assert_eq!(state.current.as_deref(), Some("0.3.0"));
        assert!(state.pending.is_none());
        state.save(&path).unwrap();
        assert_eq!(State::load(&path).unwrap().phase, "rolled-back");
        assert!(validate_nonce("../bad").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn interrupted_download_or_preparation_is_reported_without_database_rollback() {
        for phase in ["downloading", "preparing"] {
            let mut state = State {
                current: Some("0.3.0".into()),
                previous: None,
                pending: None,
                phase: phase.into(),
                message: "in progress".into(),
            };
            state.recover();
            assert_eq!(state.current.as_deref(), Some("0.3.0"));
            assert_eq!(state.phase, "failed");
            assert!(state.message.contains("remains active"));
        }
    }

    #[test]
    fn administrator_install_resets_the_active_slot_but_keeps_other_data() {
        let root = crate::layout::tests::scratch("update-installer-reset");
        let data = root.join("data");
        let updates = data.join("server-updates");
        std::fs::create_dir_all(updates.join("incoming")).unwrap();
        std::fs::write(updates.join("prepare.json"), b"{}").unwrap();
        std::fs::write(data.join("bmuster.db"), b"database fixture").unwrap();
        State {
            current: Some("0.3.1".into()),
            previous: Some("0.3.0".into()),
            pending: Some("0.3.1".into()),
            phase: "starting".into(),
            message: String::new(),
        }
        .save(&updates.join("state.json"))
        .unwrap();
        super::super::reset_for_installer(&crate::layout::Layout {
            program: root.join("program"),
            data: data.clone(),
        })
        .unwrap();
        assert_eq!(
            State::load(&updates.join("state.json")).unwrap().current,
            None
        );
        assert!(!updates.join("incoming").exists());
        assert!(!updates.join("prepare.json").exists());
        assert_eq!(
            std::fs::read(data.join("bmuster.db")).unwrap(),
            b"database fixture"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
