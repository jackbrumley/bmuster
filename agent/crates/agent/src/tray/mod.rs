//! User-session shortcuts to authenticated local management.
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "linux")]
pub mod starter;
mod status;
#[cfg(windows)]
pub mod windows;

use anyhow::{bail, Result};
use std::sync::Arc;

pub fn publish(board: Arc<crate::status::StatusBoard>, port: u16) {
    if let Err(error) = status::publish(board, port) {
        log::warn!("Tray unavailable: {error:#}");
    }
}

/// This command never starts/stops the agent or reads private enrolment files.
pub fn run(open_only: bool) -> Result<()> {
    #[cfg(unix)]
    if unsafe { libc::geteuid() } == 0 {
        bail!("Start the tray as the signed-in user, never as root");
    }
    if open_only {
        return open_management();
    }
    // The autostart entry and the agent may both start a helper for the
    // same person; the second one leaves quietly (SPEC-TRAY-SESSIONS 3).
    #[cfg(target_os = "linux")]
    {
        let Some(_lock) = linux::single_instance(&linux::runtime_dir())? else {
            log::info!("Another BMuster tray already runs for this person.");
            return Ok(());
        };
        linux::run()
    }
    #[cfg(windows)]
    {
        windows::run()
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        bail!("The BMuster tray is not available on this platform yet")
    }
}

fn open_management() -> Result<()> {
    let snapshot = status::read()?;
    open::that_detached(&snapshot.url)?;
    Ok(())
}

fn copy_url(clipboard: &mut Option<arboard::Clipboard>) -> Result<()> {
    let snapshot = status::read()?;
    if clipboard.is_none() {
        *clipboard = Some(arboard::Clipboard::new()?);
    }
    match clipboard {
        Some(clipboard) => clipboard.set_text(snapshot.url).map_err(Into::into),
        None => bail!("Clipboard could not be opened"),
    }
}

/// A small radar, in StatusNotifierItem's network-order ARGB format.
#[cfg(target_os = "linux")]
fn icon_pixels() -> Vec<u8> {
    let mut pixels = vec![0; 32 * 32 * 4];
    for y in 0..32i32 {
        for x in 0..32i32 {
            let dx = x - 16;
            let dy = y - 16;
            let radius = dx * dx + dy * dy;
            let ring = (156..=196).contains(&radius) || (42..=64).contains(&radius);
            let sweep = dx >= 0 && dy == -dx && radius <= 196;
            let centre = radius <= 5;
            if ring || sweep || centre {
                let i = ((y * 32 + x) * 4) as usize;
                pixels[i..i + 4].copy_from_slice(&[255, 36, 164, 210]);
            }
        }
    }
    pixels
}
