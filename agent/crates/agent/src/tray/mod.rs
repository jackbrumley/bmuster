//! User-session shortcuts to authenticated local management, and who is
//! connected to the screen (SPEC-DESKTOP 8.2).
mod connected;
#[cfg(target_os = "linux")]
mod disconnect;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "linux")]
mod notify;
#[cfg(target_os = "linux")]
pub mod starter;
mod status;
pub mod viewers;
#[cfg(windows)]
pub mod windows;

use anyhow::{bail, Result};
use std::sync::Arc;

pub fn publish(board: Arc<crate::status::StatusBoard>, port: u16) {
    match status::publish(board, port) {
        Ok(()) => serve_disconnect(),
        Err(error) => log::warn!("Tray unavailable: {error:#}"),
    }
}

/// Linux: the tray's Disconnect reaches the agent through a socket.
#[cfg(target_os = "linux")]
fn serve_disconnect() {
    if let Err(error) = status::directory().and_then(|dir| disconnect::serve(&dir)) {
        log::warn!("Disconnect from the tray unavailable: {error:#}");
    }
}

/// Elsewhere the notice bar has the only Disconnect.
#[cfg(not(target_os = "linux"))]
fn serve_disconnect() {}

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

/// The small BMuster mark (SPEC-BRAND-ICON) at each size the tray offers, as
/// (edge in pixels, StatusNotifierItem's network-order ARGB pixels).
/// `npm run icons:generate` draws them from docs/logo.svg.
#[cfg(target_os = "linux")]
const ICONS: [(i32, &[u8]); 3] = [
    (22, include_bytes!("../../assets/tray-22.argb")),
    (32, include_bytes!("../../assets/tray-32.argb")),
    (48, include_bytes!("../../assets/tray-48.argb")),
];

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    fn each_tray_icon_is_square_argb_of_its_size() {
        let sizes: Vec<i32> = super::ICONS.iter().map(|(edge, _)| *edge).collect();
        assert_eq!(sizes, [22, 32, 48]);
        for (edge, pixels) in super::ICONS {
            assert_eq!(pixels.len(), (edge * edge * 4) as usize, "{edge}px icon");
            // The disc's centre is opaque and the corners outside it are clear:
            // ARGB starts with alpha.
            let centre = ((edge / 2 * edge + edge / 2) * 4) as usize;
            assert_eq!(pixels[centre], 255, "{edge}px icon centre alpha");
            assert_eq!(pixels[0], 0, "{edge}px icon corner alpha");
        }
    }
}
