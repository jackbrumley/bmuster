//! Windows notification area and read-only, ACL-checked status.
use super::status;
use super::windows_sessions::{replaced, FileId, MUTEX_NAME};
use anyhow::{bail, Context as _, Result};
use std::cell::Cell;
use std::fs::{File, OpenOptions};
use std::os::windows::fs::{MetadataExt as _, OpenOptionsExt as _};
use std::os::windows::io::AsRawHandle as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use windows::core::{w, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_ALREADY_EXISTS, HANDLE, HLOCAL, HWND, LPARAM,
    LRESULT, POINT, WPARAM,
};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, GetSecurityInfo, SE_FILE_OBJECT,
};
use windows::Win32::Security::{
    GetAce, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION,
    OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
};
use windows::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
use windows::Win32::Storage::FileSystem::{
    MoveFileExW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_EXECUTE,
    FILE_GENERIC_READ, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
};
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::HiDpi::{
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_SYSTEM_AWARE,
};
use windows::Win32::UI::Shell::*;
use windows::Win32::UI::WindowsAndMessaging::*;

const CALLBACK: u32 = WM_APP + 1;
const OPEN: usize = 1;
const COPY: usize = 2;

fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt as _;
    value.encode_wide().chain(Some(0)).collect()
}

/// `sid` as a string (`S-1-5-18`).
///
/// # Safety
/// `sid` must point to a valid SID.
pub(super) unsafe fn sid_text(sid: PSID) -> Result<String> {
    let mut text = PWSTR::null();
    unsafe {
        ConvertSidToStringSidW(sid, &mut text)?;
    }
    let value = unsafe { text.to_string() };
    unsafe {
        LocalFree(Some(HLOCAL(text.0.cast())));
    }
    Ok(value?)
}

fn verify_acl(file: &File) -> Result<()> {
    let mut owner = PSID::default();
    let mut acl: *mut ACL = std::ptr::null_mut();
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    unsafe {
        GetSecurityInfo(
            HANDLE(file.as_raw_handle()),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            Some(&mut acl),
            None,
            Some(&mut descriptor),
        )
        .ok()?;
    }
    let checked = (|| -> Result<()> {
        let owner = unsafe { sid_text(owner)? };
        if !matches!(owner.as_str(), "S-1-5-18" | "S-1-5-32-544") || acl.is_null() {
            bail!("Untrusted status owner or missing DACL");
        }
        for index in 0..unsafe { (*acl).AceCount } {
            let mut ace = std::ptr::null_mut();
            unsafe {
                GetAce(acl, u32::from(index), &mut ace)?;
            }
            let header = unsafe { &*ace.cast::<ACE_HEADER>() };
            if header.AceType == 1 {
                continue;
            }
            if header.AceType != 0 {
                bail!("Unsupported status ACL entry");
            }
            let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
            let sid = PSID(std::ptr::addr_of!(allowed.SidStart).cast_mut().cast());
            let name = unsafe { sid_text(sid)? };
            if !matches!(name.as_str(), "S-1-5-18" | "S-1-5-32-544")
                && allowed.Mask & !(FILE_GENERIC_READ.0 | FILE_GENERIC_EXECUTE.0) != 0
            {
                bail!("A non-administrator can alter tray status");
            }
        }
        Ok(())
    })();
    unsafe {
        LocalFree(Some(HLOCAL(descriptor.0)));
    }
    checked
}

/// Opens `file` in the status folder, refusing anything an ordinary user
/// could have written.
pub fn open_public(dir: &Path, file: &str) -> Result<File> {
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(dir)?;
    if directory.metadata()?.file_attributes() & 0x400 != 0 {
        bail!("Status directory is a reparse point");
    }
    verify_acl(&directory)?;
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(dir.join(file))?;
    if !file.metadata()?.is_file() || file.metadata()?.file_attributes() & 0x400 != 0 {
        bail!("Status file is not a regular file");
    }
    verify_acl(&file)?;
    Ok(file)
}

/// The status folder must give ordinary users read access only.
pub fn check_publish_directory(dir: &Path) -> Result<()> {
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0 | FILE_FLAG_OPEN_REPARSE_POINT.0)
        .open(dir)?;
    verify_acl(&directory)
}

/// Writes `file` in `dir` whole: a new file, then a move over the old.
pub fn write_public(dir: &Path, file: &str, bytes: &[u8]) -> Result<()> {
    let stem = file.strip_suffix(".json").unwrap_or(file);
    let next = dir.join(format!("{stem}-{}.new", std::process::id()));
    std::fs::write(&next, bytes)?;
    let source = wide(next.as_os_str());
    let destination = wide(dir.join(file).as_os_str());
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )?;
    }
    Ok(())
}

/// The tray's two icons, made once at start on the tray's thread.
#[derive(Clone, Copy)]
struct Icons {
    plain: HICON,
    connected: HICON,
}

thread_local! {
    static ICONS: Cell<Icons> = const {
        Cell::new(Icons {
            plain: HICON(std::ptr::null_mut()),
            connected: HICON(std::ptr::null_mut()),
        })
    };
}

/// The program this helper started from, and which file it was then.
static PROGRAM: OnceLock<(PathBuf, Option<FileId>)> = OnceLock::new();
/// Timer ticks (one a second); the program is checked every fifth.
static TICKS: AtomicU32 = AtomicU32::new(0);

/// The BMuster mark at the notification area's size (SPEC-BRAND-ICON),
/// plain and with the red dot.
fn load_icons() -> Result<Icons> {
    let edge = unsafe { GetSystemMetrics(SM_CXSMICON) }.max(16);
    let make = |connected: bool| -> Result<HICON> {
        let bits =
            super::icon::tray_icon(edge.unsigned_abs(), connected).map_err(anyhow::Error::msg)?;
        let icon = unsafe {
            CreateIconFromResourceEx(&bits, true, 0x0003_0000, edge, edge, LR_DEFAULTCOLOR)
        }
        .context("Could not make the tray icon")?;
        Ok(icon)
    };
    Ok(Icons {
        plain: make(false)?,
        connected: make(true)?,
    })
}

/// The file at `path` as NTFS knows it, when it can be opened.
fn file_id(path: &Path) -> Option<FileId> {
    // Attributes only, sharing everything: never in the way of an update.
    let file = OpenOptions::new().access_mode(0).open(path).ok()?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }.ok()?;
    Some(FileId {
        volume: info.dwVolumeSerialNumber,
        index: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
    })
}

/// Every fifth tick: whether another file now stands where this helper's
/// program was (the agent's install or rescue-copy refresh puts the new
/// version there and moves the running one aside).
fn program_replaced() -> bool {
    if TICKS.fetch_add(1, Ordering::Relaxed) % 5 != 4 {
        return false;
    }
    PROGRAM
        .get()
        .is_some_and(|(path, started)| replaced(*started, file_id(path)))
}

/// Holds the session's single-instance mutex until dropped.
pub struct Instance(HANDLE);

impl Drop for Instance {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// Takes `Local\BMusterTray`, one per session; `None` when another helper
/// already holds it (the sign-in `Run` entry and the agent's starter may
/// both start one).
pub fn single_instance() -> Result<Option<Instance>> {
    let name = wide(std::ffi::OsStr::new(MUTEX_NAME));
    let handle = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) }
        .context("Could not create the tray's single-instance mutex")?;
    let already = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    let instance = Instance(handle);
    Ok((!already).then_some(instance))
}

fn icon_data(window: HWND) -> NOTIFYICONDATAW {
    let mut data = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: window,
        uID: 1,
        uFlags: NIF_MESSAGE | NIF_ICON | NIF_TIP,
        uCallbackMessage: CALLBACK,
        ..Default::default()
    };
    // Someone connected to the screen: the mark with the red dot and their
    // names (SPEC-DESKTOP 8.2); the notice bar has the Disconnect button.
    let names = status::read_viewers();
    let icons = ICONS.get();
    data.hIcon = if names.is_empty() {
        icons.plain
    } else {
        icons.connected
    };
    let state = match status::read() {
        Ok(s) => s.state.label(),
        Err(_) => "Agent not running",
    };
    let label = super::connected::title(state, &names);
    for (to, from) in data.szTip.iter_mut().take(127).zip(label.encode_utf16()) {
        *to = from;
    }
    data
}

unsafe extern "system" fn procedure(window: HWND, message: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    match message {
        _ if message == unsafe { RegisterWindowMessageW(w!("TaskbarCreated")) } => {
            unsafe {
                let _ = Shell_NotifyIconW(NIM_ADD, &icon_data(window));
            }
            LRESULT(0)
        }
        WM_TIMER => {
            if program_replaced() {
                // A new version of the program is in place: this helper
                // bows out and the agent's tray starter runs the new one
                // within about 30 s (SPEC-TRAY-SESSIONS, Windows).
                log::info!("A new agent version is in place; the tray helper restarts on it.");
                unsafe {
                    let _ = DestroyWindow(window);
                }
                return LRESULT(0);
            }
            unsafe {
                let _ = Shell_NotifyIconW(NIM_MODIFY, &icon_data(window));
            }
            LRESULT(0)
        }
        CALLBACK => {
            let event = lp.0 as u32;
            if event == WM_LBUTTONUP {
                if let Err(error) = super::open_management() {
                    log::warn!("Open management: {error:#}");
                }
            } else if event == WM_RBUTTONUP {
                let result = unsafe { menu(window) };
                if let Err(error) = result {
                    log::warn!("Tray menu: {error:#}");
                }
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            unsafe {
                let _ = Shell_NotifyIconW(NIM_DELETE, &icon_data(window));
                PostQuitMessage(0);
            }
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(window, message, wp, lp) },
    }
}

unsafe fn menu(window: HWND) -> Result<()> {
    let menu = unsafe { CreatePopupMenu()? };
    let snapshot = status::read();
    let label = snapshot
        .as_ref()
        .map(|s| s.state.label())
        .unwrap_or("Agent not running");
    let label = wide(std::ffi::OsStr::new(label));
    let names = status::read_viewers();
    let viewers = if names.is_empty() {
        Vec::new()
    } else {
        wide(std::ffi::OsStr::new(&bmuster_desktop::notice::bar_text(
            &names,
        )))
    };
    let flags = if snapshot.is_ok() {
        MF_STRING
    } else {
        MF_STRING | MF_GRAYED
    };
    let result = (|| -> Result<()> {
        unsafe {
            AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, PCWSTR(label.as_ptr()))?;
            if !viewers.is_empty() {
                AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, PCWSTR(viewers.as_ptr()))?;
            }
            AppendMenuW(menu, flags, OPEN, w!("Open local management"))?;
            AppendMenuW(menu, flags, COPY, w!("Copy local URL"))?;
            let mut point = POINT::default();
            GetCursorPos(&mut point)?;
            let _ = SetForegroundWindow(window);
            let choice = TrackPopupMenu(
                menu,
                TPM_RETURNCMD | TPM_NONOTIFY,
                point.x,
                point.y,
                None,
                window,
                None,
            )
            .0 as usize;
            if choice == OPEN {
                super::open_management()?;
            } else if choice == COPY {
                super::copy_url(&mut None)?;
            }
        }
        Ok(())
    })();
    unsafe {
        DestroyMenu(menu)?;
    }
    result
}

pub fn run() -> Result<()> {
    // Real pixels, so the icon is made at the notification area's own size.
    if let Err(error) = unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_SYSTEM_AWARE) }
    {
        log::debug!("Tray DPI awareness: {error}");
    }
    let program = std::env::current_exe().context("could not find this program's path")?;
    let started = file_id(&program);
    let _ = PROGRAM.set((program, started));
    let icons = load_icons()?;
    ICONS.set(icons);
    let result = message_loop();
    unsafe {
        let _ = DestroyIcon(icons.plain);
        let _ = DestroyIcon(icons.connected);
    }
    result
}

fn message_loop() -> Result<()> {
    unsafe {
        let instance = windows::Win32::System::LibraryLoader::GetModuleHandleW(None)?;
        let class = w!("BMusterAgentTray");
        let info = WNDCLASSW {
            lpfnWndProc: Some(procedure),
            hInstance: instance.into(),
            lpszClassName: class,
            ..Default::default()
        };
        if RegisterClassW(&info) == 0 {
            bail!("Could not register the tray window");
        }
        let window = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!("BMuster"),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance.into()),
            None,
        )?;
        if !Shell_NotifyIconW(NIM_ADD, &icon_data(window)).as_bool() {
            let _ = DestroyWindow(window);
            bail!("Could not add the notification icon");
        }
        // Every second, so a new viewer shows in the icon at once.
        if SetTimer(Some(window), 1, 1000, None) == 0 {
            let _ = DestroyWindow(window);
            bail!("Could not start the tray timer");
        }
        let mut message = MSG::default();
        loop {
            let result = GetMessageW(&mut message, None, 0, 0).0;
            if result == -1 {
                bail!("Tray message loop failed");
            }
            if result == 0 {
                break;
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    Ok(())
}

pub fn install(binary: &Path) -> Result<()> {
    let dir = status::directory()?;
    std::fs::create_dir_all(&dir)?;
    for arguments in [
        vec![dir.as_os_str().to_owned(), "/reset".into()],
        bmuster_service::windows::restrict_dir_arguments(
            &dir,
            &["*S-1-5-32-545:(OI)(CI)RX".into()],
        ),
        vec![
            dir.as_os_str().to_owned(),
            "/setowner".into(),
            "*S-1-5-18".into(),
        ],
    ] {
        if !std::process::Command::new("icacls")
            .args(arguments)
            .status()?
            .success()
        {
            bail!("Could not protect the public status folder");
        }
    }
    let path = format!("\"{}\" tray", binary.display());
    if !std::process::Command::new("reg")
        .args([
            "add",
            r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run",
            "/v",
            "BMusterAgent",
            "/t",
            "REG_SZ",
            "/d",
            &path,
            "/f",
        ])
        .status()?
        .success()
    {
        bail!("Could not install the tray autostart entry");
    }
    // The shortcut opens management directly, even without a tray host.
    let programs = bmuster_service::windows::known_folder("ProgramData")?
        .join(r"Microsoft\Windows\Start Menu\Programs");
    std::fs::create_dir_all(&programs)?;
    let script = format!("$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');$s.TargetPath='{}';$s.Arguments='tray --open';$s.Save()", programs.join("BMuster.lnk").display().to_string().replace('\'', "''"), binary.display().to_string().replace('\'', "''"));
    if !std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .status()?
        .success()
    {
        bail!("Could not create BMuster's Start menu shortcut");
    }
    Ok(())
}

pub fn uninstall() -> Result<()> {
    let key = r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run";
    let query = std::process::Command::new("reg")
        .args(["query", key, "/v", "BMusterAgent"])
        .output()?;
    if query.status.success()
        && !std::process::Command::new("reg")
            .args(["delete", key, "/v", "BMusterAgent", "/f"])
            .status()?
            .success()
    {
        bail!("Could not remove the tray autostart entry");
    }
    let shortcut = bmuster_service::windows::known_folder("ProgramData")?
        .join(r"Microsoft\Windows\Start Menu\Programs\BMuster.lnk");
    if shortcut.exists() {
        std::fs::remove_file(shortcut).context("Could not remove the BMuster shortcut")?;
    }
    Ok(())
}
