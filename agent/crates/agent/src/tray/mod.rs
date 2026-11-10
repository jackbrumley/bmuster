//! User-session shortcuts to authenticated local management.
#[cfg(target_os = "linux")]
pub mod linux;
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
    #[cfg(target_os = "linux")]
    {
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
            // The tile's centre is opaque: ARGB starts with alpha.
            let centre = ((edge / 2 * edge + edge / 2) * 4) as usize;
            assert_eq!(pixels[centre], 255, "{edge}px icon centre alpha");
        }
    }
}
