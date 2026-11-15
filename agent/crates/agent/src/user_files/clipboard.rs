//! Files on the clipboard (SPEC-SESSION-FILES 4.6, SF20, SF22), done by the
//! user files helper as the person, so no root or SYSTEM process ever
//! reads or writes a file list.
//!
//! - Linux: Wayland data-control first (KWin, wlroots, COSMIC, niri), then
//!   the X11 `CLIPBOARD` of the session's display (Xorg, or XWayland, which
//!   GNOME and others bridge to the Wayland clipboard both ways), with
//!   `text/uri-list` and `x-special/gnome-copied-files`. The display comes
//!   from the person's systemd user environment, as for the KMS clipboard
//!   helper (SPEC-DESKTOP 21.10).
//! - Windows: `CF_HDROP` with `Preferred DropEffect` = copy, on the
//!   interactive desktop the helper was started on.

use bmuster_desktop::clipboard::files::CopiedItem;
use std::path::PathBuf;

/// The clipboard's file lists.
pub trait FileClipboard: Send {
    /// Makes `paths` the clipboard's contents, as files.
    fn put(&mut self, paths: &[PathBuf]) -> Result<(), String>;
    /// The copied file list; `None` when the clipboard holds no files.
    fn read(&mut self) -> Result<Option<Vec<CopiedItem>>, String>;
}

/// The person's real clipboard.
pub fn system() -> Box<dyn FileClipboard> {
    platform::system()
}

#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use crate::wayland::session_clipboard::{helper, xwayland};
    use bmuster_desktop::clipboard::files::{
        gnome_copied_files, parse_list, uri_list, GNOME_COPIED_FILES, URI_LIST,
    };
    use bmuster_desktop::clipboard::x11::X11Clipboard;
    use bmuster_desktop::clipboard::CLIPBOARD_WAIT;
    use std::os::unix::ffi::OsStrExt as _;
    use wl_clipboard_rs::{copy, paste};

    /// The largest file list read (a few thousand paths).
    const MAX_LIST_BYTES: usize = 4 * 1024 * 1024;

    pub struct Linux {
        wayland: bool,
        x11: Result<X11Clipboard, String>,
    }

    pub fn system() -> Box<dyn FileClipboard> {
        let runtime = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from);
        let environment = helper::session_environment().unwrap_or_else(|error| {
            log::info!("The session's environment is unavailable: {error:#}");
            Default::default()
        });
        let wayland = environment
            .get("WAYLAND_DISPLAY")
            .filter(|display| !display.is_empty())
            .cloned()
            .map(Ok)
            .or_else(|| {
                runtime
                    .as_deref()
                    .map(crate::wayland::helper::find_wayland_display)
            });
        let wayland = match wayland {
            Some(Ok(display)) => {
                // wl-clipboard-rs connects to WAYLAND_DISPLAY; set before any thread.
                std::env::set_var("WAYLAND_DISPLAY", display);
                true
            }
            _ => false,
        };
        let found = runtime
            .as_deref()
            .map(xwayland::xauthority_files)
            .unwrap_or_default();
        let x11 = xwayland::target(&environment, &found).map(X11Clipboard::new);
        Box::new(Linux { wayland, x11 })
    }

    fn bytes(paths: &[PathBuf]) -> Vec<Vec<u8>> {
        paths
            .iter()
            .map(|path| path.as_os_str().as_bytes().to_vec())
            .collect()
    }

    /// Data-control's answer: `Err(None)` when the compositor has none.
    fn data_control_put(paths: &[Vec<u8>]) -> Result<(), Option<String>> {
        let sources = vec![
            copy::MimeSource {
                source: copy::Source::Bytes(uri_list(paths).into_bytes().into()),
                mime_type: copy::MimeType::Specific(URI_LIST.into()),
            },
            copy::MimeSource {
                source: copy::Source::Bytes(gnome_copied_files(paths).into_bytes().into()),
                mime_type: copy::MimeType::Specific(GNOME_COPIED_FILES.into()),
            },
        ];
        copy::Options::new()
            .copy_multi(sources)
            .map_err(|error| match error {
                copy::Error::MissingProtocol { .. }
                | copy::Error::WaylandConnection(_)
                | copy::Error::SocketOpenError(_)
                | copy::Error::NoSeats => None,
                other => Some(format!("Wayland clipboard: {other}")),
            })
    }

    fn data_control_read() -> Result<Option<Vec<CopiedItem>>, Option<String>> {
        use paste::{ClipboardType, MimeType, Seat};
        let unsupported = |error: paste::Error| match error {
            paste::Error::ClipboardEmpty | paste::Error::NoMimeType => Ok(None),
            paste::Error::MissingProtocol { .. }
            | paste::Error::WaylandConnection(_)
            | paste::Error::SocketOpenError(_)
            | paste::Error::NoSeats => Err(None),
            other => Err(Some(format!("Wayland clipboard: {other}"))),
        };
        let offered = match paste::get_mime_types_ordered(ClipboardType::Regular, Seat::Unspecified)
        {
            Ok(offered) => offered,
            Err(error) => return unsupported(error),
        };
        let Some(mime) = [URI_LIST, GNOME_COPIED_FILES]
            .into_iter()
            .find(|wanted| offered.iter().any(|offered| offered == wanted))
        else {
            return Ok(None);
        };
        let (pipe, _) = match paste::get_contents(
            ClipboardType::Regular,
            Seat::Unspecified,
            MimeType::Specific(mime),
        ) {
            Ok(contents) => contents,
            Err(error) => return unsupported(error),
        };
        let read = crate::wayland::session_clipboard::routes::read_within(
            pipe.into(),
            MAX_LIST_BYTES,
            CLIPBOARD_WAIT,
        )
        .map_err(Some)?;
        Ok(Some(parse_list(mime, &String::from_utf8_lossy(&read))))
    }

    impl FileClipboard for Linux {
        fn put(&mut self, paths: &[PathBuf]) -> Result<(), String> {
            let paths = bytes(paths);
            if self.wayland {
                match data_control_put(&paths) {
                    Ok(()) => return Ok(()),
                    Err(Some(error)) => return Err(error),
                    Err(None) => {}
                }
            }
            match self.x11.as_mut() {
                Ok(x11) => x11.set_files(&paths).map_err(|error| error.0),
                Err(reason) => Err(format!("No clipboard reachable: {reason}")),
            }
        }

        fn read(&mut self) -> Result<Option<Vec<CopiedItem>>, String> {
            if self.wayland {
                match data_control_read() {
                    Ok(found) => return Ok(found),
                    Err(Some(error)) => return Err(error),
                    Err(None) => {}
                }
            }
            match self.x11.as_mut() {
                Ok(x11) => Ok(x11
                    .get_files()
                    .map_err(|error| error.0)?
                    .map(|(mime, text)| parse_list(mime, &text))),
                Err(reason) => Err(format!("No clipboard reachable: {reason}")),
            }
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};
    use windows::core::w;
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, GetClipboardData, IsClipboardFormatAvailable,
        OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_HDROP;
    use windows::Win32::UI::Shell::{DragQueryFileW, HDROP};

    /// `DROPEFFECT_COPY`.
    const COPY: u32 = 1;

    pub struct Windows;

    pub fn system() -> Box<dyn FileClipboard> {
        Box::new(Windows)
    }

    /// The clipboard, open until dropped.
    struct Open;

    impl Open {
        fn new() -> Result<Open, String> {
            for _ in 0..10 {
                // SAFETY: no owner window; closed in Drop.
                if unsafe { OpenClipboard(None) }.is_ok() {
                    return Ok(Open);
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err("Another program is holding the machine's clipboard.".into())
        }
    }

    impl Drop for Open {
        fn drop(&mut self) {
            // SAFETY: opened in `new`.
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    /// Copies `bytes` into a movable global block for the clipboard.
    fn global(bytes: &[u8]) -> Result<HGLOBAL, String> {
        // SAFETY: a fresh block of the stated size, written while locked.
        unsafe {
            let block = GlobalAlloc(GMEM_MOVEABLE, bytes.len()).map_err(|e| e.to_string())?;
            let at = GlobalLock(block);
            if at.is_null() {
                let _ = GlobalFree(Some(block));
                return Err("GlobalLock failed".into());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), at.cast::<u8>(), bytes.len());
            let _ = GlobalUnlock(block);
            Ok(block)
        }
    }

    impl FileClipboard for Windows {
        fn put(&mut self, paths: &[PathBuf]) -> Result<(), String> {
            let _open = Open::new()?;
            // SAFETY: the clipboard is open; ownership of each block passes
            // to the clipboard when SetClipboardData succeeds.
            unsafe {
                EmptyClipboard().map_err(|e| format!("EmptyClipboard: {e}"))?;
                let wide: Vec<Vec<u16>> = paths
                    .iter()
                    .map(|path| path.as_os_str().encode_wide().collect())
                    .collect();
                let drop = global(&super::hdrop(&wide))?;
                SetClipboardData(u32::from(CF_HDROP.0), Some(HANDLE(drop.0)))
                    .map_err(|e| format!("SetClipboardData: {e}"))?;
                let effect = RegisterClipboardFormatW(w!("Preferred DropEffect"));
                if effect != 0 {
                    let block = global(&COPY.to_le_bytes())?;
                    let _ = SetClipboardData(effect, Some(HANDLE(block.0)));
                }
            }
            Ok(())
        }

        fn read(&mut self) -> Result<Option<Vec<CopiedItem>>, String> {
            // SAFETY: a format check needs no open clipboard.
            if unsafe { IsClipboardFormatAvailable(u32::from(CF_HDROP.0)) }.is_err() {
                return Ok(None);
            }
            let _open = Open::new()?;
            // SAFETY: the clipboard is open; the handle is the clipboard's,
            // read and never freed here.
            unsafe {
                let Ok(data) = GetClipboardData(u32::from(CF_HDROP.0)) else {
                    return Ok(None);
                };
                let drop = HDROP(data.0);
                let count = DragQueryFileW(drop, u32::MAX, None);
                let mut items = Vec::new();
                for index in 0..count {
                    let length = DragQueryFileW(drop, index, None) as usize;
                    let mut buffer = vec![0u16; length + 1];
                    let got = DragQueryFileW(drop, index, Some(&mut buffer)) as usize;
                    buffer.truncate(got);
                    let path = PathBuf::from(std::ffi::OsString::from_wide(&buffer));
                    // Only paths on a drive letter are on this machine's disks.
                    let local = buffer.len() > 2
                        && buffer[1] == u16::from(b':')
                        && (buffer[2] == u16::from(b'\\') || buffer[2] == u16::from(b'/'));
                    items.push(if local {
                        CopiedItem::Local(path)
                    } else {
                        CopiedItem::NotLocal
                    });
                }
                Ok(Some(items))
            }
        }
    }
}

/// `CF_HDROP`'s bytes: a `DROPFILES` header (20 bytes: the offset of the
/// list, a point, `fNC`, `fWide` = 1), then each wide path NUL-ended, then
/// one more NUL.
#[cfg(any(windows, test))]
pub fn hdrop(paths: &[Vec<u16>]) -> Vec<u8> {
    const HEADER: u32 = 20;
    let mut bytes = Vec::new();
    for field in [HEADER, 0, 0, 0, 1] {
        bytes.extend_from_slice(&field.to_le_bytes());
    }
    for path in paths {
        for unit in path.iter().copied().chain(Some(0)) {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
    }
    bytes.extend_from_slice(&[0, 0]);
    bytes
}

#[cfg(test)]
mod tests {
    /// SF21 (Windows): the `CF_HDROP` layout.
    #[test]
    fn sf21_hdrop_layout() {
        let wide = |text: &str| text.encode_utf16().collect::<Vec<u16>>();
        let bytes = super::hdrop(&[wide(r"C:\a"), wide(r"D:\é")]);
        assert_eq!(&bytes[..4], &20u32.to_le_bytes(), "pFiles");
        assert_eq!(&bytes[16..20], &1u32.to_le_bytes(), "fWide");
        let units: Vec<u16> = bytes[20..]
            .chunks(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let mut expected = wide(r"C:\a");
        expected.push(0);
        expected.extend(wide(r"D:\é"));
        expected.extend([0, 0]);
        assert_eq!(units, expected);
    }
}

#[cfg(all(test, unix))]
pub mod fake {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// A clipboard in memory: what was put, and what a test copies.
    #[derive(Clone, Default)]
    pub struct Fake {
        pub held: Arc<Mutex<Option<Vec<CopiedItem>>>>,
    }

    impl FileClipboard for Fake {
        fn put(&mut self, paths: &[PathBuf]) -> Result<(), String> {
            *self.held.lock().unwrap() = Some(
                paths
                    .iter()
                    .map(|path| CopiedItem::Local(path.clone()))
                    .collect(),
            );
            Ok(())
        }

        fn read(&mut self) -> Result<Option<Vec<CopiedItem>>, String> {
            Ok(self.held.lock().unwrap().clone())
        }
    }
}
