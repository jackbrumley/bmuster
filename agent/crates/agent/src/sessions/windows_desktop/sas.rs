//! Ctrl+Alt+Del from the service (SPEC-DESKTOP 5.3): `SendSAS` works only
//! while the `SoftwareSASGeneration` policy lets services send it. The
//! installer allows it, and so does the first Ctrl+Alt+Del on an agent that
//! was installed before this (agents update without reinstalling). What
//! the value was before is kept in `sas-policy.json` in the data folder;
//! the uninstaller puts it back, unless someone changed it since.

use crate::identity;
use anyhow::{Context as _, Result};
use bmuster_desktop::winsession::sas_policy::{
    restore, value_to_set, Record, Restore, POLICY_KEY, POLICY_VALUE, RECORD_FILE,
};
use std::path::Path;
use windows_registry::{Key, LOCAL_MACHINE};

fn policy_key() -> Result<Key> {
    LOCAL_MACHINE
        .create(POLICY_KEY)
        .with_context(|| format!(r"could not open HKLM\{POLICY_KEY}"))
}

fn current(key: &Key) -> Option<u32> {
    key.get_u32(POLICY_VALUE).ok()
}

fn read_record(data_dir: &Path) -> Result<Option<Record>> {
    let path = data_dir.join(RECORD_FILE);
    if !path.exists() {
        return Ok(None);
    }
    let text =
        std::fs::read(&path).with_context(|| format!("could not read {}", path.display()))?;
    serde_json::from_slice(&text)
        .map(Some)
        .with_context(|| format!("{} is unreadable", path.display()))
}

/// Lets services send Ctrl+Alt+Del, recording the value it replaces (only
/// the first time, so the record keeps the machine's own value).
pub fn allow_services(data_dir: &Path) -> Result<()> {
    let key = policy_key()?;
    let before = current(&key);
    let Some(value) = value_to_set(before) else {
        return Ok(());
    };
    if read_record(data_dir)?.is_none() {
        let record = Record { before, set: value };
        identity::write_private(&data_dir.join(RECORD_FILE), &serde_json::to_vec(&record)?)?;
    }
    key.set_u32(POLICY_VALUE, value)
        .with_context(|| format!("could not set {POLICY_VALUE}"))?;
    log::info!("Set {POLICY_VALUE} to {value} (was {before:?}) so the agent can send Ctrl+Alt+Del");
    Ok(())
}

/// The uninstaller's step: puts back what BMuster replaced.
pub fn restore_policy(data_dir: &Path) -> Result<()> {
    let record = read_record(data_dir)?;
    let key = policy_key()?;
    match restore(record.as_ref(), current(&key)) {
        Restore::Leave => {}
        Restore::Delete => {
            key.remove_value(POLICY_VALUE)
                .with_context(|| format!("could not remove {POLICY_VALUE}"))?;
            log::info!("Removed {POLICY_VALUE}, which BMuster had set");
        }
        Restore::Set(value) => {
            key.set_u32(POLICY_VALUE, value)
                .with_context(|| format!("could not restore {POLICY_VALUE}"))?;
            log::info!("Restored {POLICY_VALUE} to {value}");
        }
    }
    let path = data_dir.join(RECORD_FILE);
    if path.exists() {
        std::fs::remove_file(&path)
            .with_context(|| format!("could not remove {}", path.display()))?;
    }
    Ok(())
}

/// Sends Ctrl+Alt+Del to the console, allowing it first if needed.
pub fn send(data_dir: &Path) -> Result<(), String> {
    allow_services(data_dir).map_err(|e| format!("{e:#}"))?;
    bmuster_desktop::winsession::sas::send_sas()
}
