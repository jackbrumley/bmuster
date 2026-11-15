//! Where sent files go (SPEC-SESSION-FILES 4.3, SF4, SF5): the person's
//! Downloads folder, then `BMuster` in it, made when missing.
//!
//! - Windows: the Downloads Known Folder, which follows a moved Downloads.
//! - Linux: `XDG_DOWNLOAD_DIR` from `user-dirs.dirs`, read without
//!   evaluating it: only `"$HOME/…"` or an absolute path is taken; `$HOME`
//!   itself (the "disabled" convention) or anything else means
//!   `~/Downloads`.
//! - macOS (when an agent exists): `~/Downloads`.
//!
//! The `BMuster` folder must be a real folder the person owns: never a
//! link or junction. Once opened, every operation is relative to that
//! handle (Linux: `openat`, `renameat2`), so swapping it for a link
//! mid-transfer changes nothing. On Windows the folder's handle is held
//! without delete sharing, so it cannot be renamed or replaced while open.

use super::UserError;
use bmuster_protocol::user_files::{UserFilesError, FOLDER_NAME};
use std::path::{Path, PathBuf};

#[cfg(unix)]
/// `XDG_DOWNLOAD_DIR` from the text of `user-dirs.dirs`, when it names a
/// folder other than `home` itself.
pub fn user_dirs_download(text: &str, home: &Path) -> Option<PathBuf> {
    let value = text.lines().rev().find_map(|line| {
        let line = line.trim();
        let value = line.strip_prefix("XDG_DOWNLOAD_DIR=")?;
        value
            .strip_prefix('"')?
            .strip_suffix('"')
            .map(str::to_string)
    })?;
    if value.contains('\\') || value.contains('`') || value.contains("..") {
        return None;
    }
    let path = if let Some(rest) = value.strip_prefix("$HOME") {
        let rest = rest.trim_start_matches('/');
        if !value[5..].is_empty() && !value[5..].starts_with('/') {
            return None;
        }
        if rest.is_empty() || rest.contains('$') {
            return None;
        }
        home.join(rest)
    } else if value.starts_with('/') && !value.contains('$') {
        PathBuf::from(value)
    } else {
        return None;
    };
    (path != home).then_some(path)
}

#[cfg(unix)]
/// The Downloads folder for a person whose home is `home` and whose
/// `user-dirs.dirs` holds `user_dirs` (if it could be read).
pub fn linux_downloads(home: &Path, user_dirs: Option<&str>) -> PathBuf {
    user_dirs
        .and_then(|text| user_dirs_download(text, home))
        .unwrap_or_else(|| home.join("Downloads"))
}

/// How the person would name the folder: relative to their home when it is
/// inside it, with the system's separator (`Downloads/BMuster`,
/// `Downloads\BMuster`, `Téléchargements/BMuster`).
pub fn label(downloads: &Path, home: &Path, separator: char) -> String {
    let shown = downloads.strip_prefix(home).unwrap_or(downloads);
    let mut parts: Vec<String> = shown
        .components()
        .filter_map(|part| match part {
            std::path::Component::Normal(name) => Some(name.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect();
    parts.push(FOLDER_NAME.to_string());
    let joined = parts.join(&separator.to_string());
    if shown.is_absolute() && separator == '/' {
        format!("/{joined}")
    } else {
        joined
    }
}

/// The helper's own Downloads folder, its label and the person's name.
pub fn this_person() -> Result<(PathBuf, String, String), UserError> {
    platform::this_person()
}

fn not_owned(user: &str, label: &str) -> UserError {
    UserError::new(
        UserFilesError::NotOwned,
        format!(
            "{user}'s {label} is not an ordinary folder they own, so nothing was saved. Rename or remove it on the machine."
        ),
    )
}

#[cfg(unix)]
pub use unix::Folder;
#[cfg(windows)]
pub use win::Folder;

#[cfg(unix)]
mod platform {
    use super::*;

    pub fn this_person() -> Result<(PathBuf, String, String), UserError> {
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|home| home.is_absolute())
            .ok_or_else(|| UserError::invalid("The person on the screen has no home folder."))?;
        let user = std::env::var("USER")
            .ok()
            .filter(|user| !user.is_empty())
            .unwrap_or_else(|| "The person".into());
        let config = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".config"));
        let text = std::fs::read_to_string(config.join("user-dirs.dirs")).ok();
        let downloads = linux_downloads(&home, text.as_deref());
        let label = label(&downloads, &home, '/');
        Ok((downloads, label, user))
    }
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::ffi::CString;
    use std::fs::File;
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;

    /// Downloads/BMuster, opened once and used only through its handle.
    pub struct Folder {
        dir: OwnedFd,
        /// The folder as the person names it.
        pub label: String,
        /// The person's name, for messages.
        pub user: String,
    }

    fn c_name(name: &str) -> io::Result<CString> {
        CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
    }

    fn check(result: libc::c_int) -> io::Result<libc::c_int> {
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(result)
        }
    }

    impl Folder {
        /// Makes Downloads and BMuster if missing, then opens BMuster
        /// without following a link, and checks it is a folder the helper's
        /// own user owns.
        pub fn open(downloads: &Path, label: String, user: String) -> Result<Folder, UserError> {
            let failed = |error: io::Error| UserError::io(&error, "files", &user, &label);
            std::fs::create_dir_all(downloads).map_err(failed)?;
            let path = CString::new(downloads.as_os_str().as_bytes())
                .map_err(|_| UserError::invalid("The Downloads folder's path holds a NUL."))?;
            // SAFETY: a NUL-terminated path; the descriptor is owned at once.
            let parent = unsafe {
                OwnedFd::from_raw_fd(
                    check(libc::open(
                        path.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
                    ))
                    .map_err(failed)?,
                )
            };
            let name = c_name(FOLDER_NAME).map_err(failed)?;
            // SAFETY: a directory descriptor and a NUL-terminated name.
            let made = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) };
            if made < 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(failed(error));
                }
            }
            // SAFETY: as above; O_NOFOLLOW refuses a link in BMuster's place.
            let opened = unsafe {
                libc::openat(
                    parent.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if opened < 0 {
                let error = io::Error::last_os_error();
                return Err(match error.raw_os_error() {
                    Some(libc::ELOOP | libc::ENOTDIR) => not_owned(&user, &label),
                    _ => failed(error),
                });
            }
            // SAFETY: the descriptor was just opened.
            let dir = unsafe { OwnedFd::from_raw_fd(opened) };
            // SAFETY: an out-parameter for fstat on an open descriptor.
            let mut stat: libc::stat = unsafe { std::mem::zeroed() };
            check(unsafe { libc::fstat(dir.as_raw_fd(), &mut stat) }).map_err(failed)?;
            // SAFETY: geteuid cannot fail.
            let me = unsafe { libc::geteuid() };
            if stat.st_mode & libc::S_IFMT != libc::S_IFDIR || stat.st_uid != me {
                return Err(not_owned(&user, &label));
            }
            Ok(Folder { dir, label, user })
        }

        fn open_at(&self, name: &str, flags: libc::c_int) -> io::Result<File> {
            let name = c_name(name)?;
            // SAFETY: a directory descriptor, a NUL-terminated name; the new
            // descriptor is owned at once. Never follows a link.
            let fd = check(unsafe {
                libc::openat(
                    self.dir.as_raw_fd(),
                    name.as_ptr(),
                    flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    0o600 as libc::c_uint,
                )
            })?;
            // SAFETY: just opened.
            Ok(unsafe { File::from_raw_fd(fd) })
        }

        /// A new part file; fails if anything of that name exists.
        pub fn create(&self, name: &str) -> io::Result<File> {
            self.open_at(name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL)
        }

        /// An existing file of the folder, for appending or reading.
        pub fn open_existing(&self, name: &str, write: bool) -> io::Result<File> {
            let file = self.open_at(
                name,
                if write {
                    libc::O_WRONLY
                } else {
                    libc::O_RDONLY
                },
            )?;
            if !file.metadata()?.is_file() {
                return Err(io::Error::from(io::ErrorKind::InvalidInput));
            }
            Ok(file)
        }

        pub fn remove(&self, name: &str) -> io::Result<()> {
            let name = c_name(name)?;
            // SAFETY: a directory descriptor and a NUL-terminated name.
            check(unsafe { libc::unlinkat(self.dir.as_raw_fd(), name.as_ptr(), 0) }).map(drop)
        }

        /// Renames `from` to `to` inside the folder, failing with
        /// `AlreadyExists` rather than replacing anything.
        pub fn rename_new(&self, from: &str, to: &str) -> io::Result<()> {
            let (from, to) = (c_name(from)?, c_name(to)?);
            let dir = self.dir.as_raw_fd();
            // SAFETY: directory descriptors and NUL-terminated names.
            check(unsafe {
                libc::renameat2(dir, from.as_ptr(), dir, to.as_ptr(), libc::RENAME_NOREPLACE)
            })
            .map(drop)
        }

        /// Bytes free to the person on the folder's disk.
        pub fn free(&self) -> io::Result<u64> {
            // SAFETY: an out-parameter for fstatvfs on an open descriptor.
            let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
            check(unsafe { libc::fstatvfs(self.dir.as_raw_fd(), &mut stat) })?;
            Ok(stat.f_bavail.saturating_mul(stat.f_frsize))
        }

        /// The names in the folder (through the open handle).
        pub fn names(&self) -> io::Result<Vec<String>> {
            let listed = PathBuf::from(format!("/proc/self/fd/{}", self.dir.as_raw_fd()));
            Ok(std::fs::read_dir(listed)?
                .flatten()
                .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
                .collect())
        }

        /// Sets a saved file private to the person (open question 6).
        pub fn make_private(file: &File) -> io::Result<()> {
            use std::os::unix::fs::PermissionsExt as _;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{FOLDERID_Downloads, SHGetKnownFolderPath, KF_FLAG_CREATE};

    pub fn this_person() -> Result<(PathBuf, String, String), UserError> {
        // SAFETY: Windows allocates the path, read here and freed once.
        let downloads = unsafe {
            let raw =
                SHGetKnownFolderPath(&FOLDERID_Downloads, KF_FLAG_CREATE, None).map_err(|e| {
                    UserError::invalid(format!("Cannot find the Downloads folder: {e}"))
                })?;
            let text = raw.to_string();
            CoTaskMemFree(Some(raw.0.cast_const().cast()));
            PathBuf::from(text.map_err(|e| UserError::invalid(format!("The Downloads path: {e}")))?)
        };
        let home = std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_default();
        let user = std::env::var("USERNAME")
            .ok()
            .filter(|user| !user.is_empty())
            .unwrap_or_else(|| "The person".into());
        let label = label(&downloads, &home, '\\');
        Ok((downloads, label, user))
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::fs::OpenOptionsExt as _;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
    use windows::Win32::Security::{
        EqualSid, GetTokenInformation, TokenUser, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR,
        PSID, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, GetDiskFreeSpaceExW, GetFileInformationByHandle, MoveFileExW,
        BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
        FILE_SHARE_READ, FILE_SHARE_WRITE, MOVE_FILE_FLAGS, OPEN_EXISTING, READ_CONTROL,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// `FILE_FLAG_OPEN_REPARSE_POINT`, for files opened inside the folder.
    const NO_REPARSE: u32 = FILE_FLAG_OPEN_REPARSE_POINT.0;

    struct Owned(HANDLE);

    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: our handle, closed once.
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }

    // SAFETY: a file handle may be used from any thread.
    unsafe impl Send for Owned {}

    /// Downloads\BMuster, held open without delete sharing.
    pub struct Folder {
        _held: Owned,
        path: PathBuf,
        pub label: String,
        pub user: String,
    }

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    /// Whether the security descriptor's owner is this process's user.
    fn owned_by_me(handle: HANDLE) -> Result<bool, String> {
        let mut owner = PSID::default();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        // SAFETY: out-parameters; the descriptor is freed once below, and
        // `owner` points into it.
        unsafe {
            GetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                Some(&mut owner),
                None,
                None,
                None,
                Some(&mut descriptor),
            )
            .ok()
            .map_err(|e| format!("GetSecurityInfo: {e}"))?;
            let mine = me_equals(owner);
            let _ = LocalFree(Some(HLOCAL(descriptor.0)));
            mine
        }
    }

    /// Whether `sid` is this process's token user.
    ///
    /// # Safety
    /// `sid` must point to a valid SID.
    unsafe fn me_equals(sid: PSID) -> Result<bool, String> {
        let mut token = HANDLE::default();
        // SAFETY: our own process token, owned at once.
        unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) }
            .map_err(|e| format!("OpenProcessToken: {e}"))?;
        let token = Owned(token);
        let mut length = 0u32;
        // SAFETY: the first call reports the size; the second writes a
        // TOKEN_USER into an aligned buffer of that size.
        unsafe {
            let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut length);
            let mut buffer = vec![0u64; (length as usize).div_ceil(8)];
            GetTokenInformation(
                token.0,
                TokenUser,
                Some(buffer.as_mut_ptr().cast()),
                length,
                &mut length,
            )
            .map_err(|e| format!("GetTokenInformation: {e}"))?;
            let user = &*buffer.as_ptr().cast::<TOKEN_USER>();
            Ok(EqualSid(user.User.Sid, sid).is_ok())
        }
    }

    impl Folder {
        pub fn open(downloads: &Path, label: String, user: String) -> Result<Folder, UserError> {
            let failed = |error: io::Error| UserError::io(&error, "files", &user, &label);
            let path = downloads.join(FOLDER_NAME);
            std::fs::create_dir_all(&path).map_err(failed)?;
            let name = wide(&path);
            // SAFETY: a NUL-terminated path; the handle is owned at once.
            // No delete sharing: the folder cannot be renamed or replaced
            // while it is held. The reparse point itself is opened, never
            // followed.
            let handle = unsafe {
                CreateFileW(
                    PCWSTR(name.as_ptr()),
                    (FILE_LIST_DIRECTORY | READ_CONTROL).0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    None,
                    OPEN_EXISTING,
                    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                    None,
                )
            }
            .map_err(|e| failed(io::Error::from_raw_os_error(e.code().0 & 0xffff)))?;
            let held = Owned(handle);
            let mut info = BY_HANDLE_FILE_INFORMATION::default();
            // SAFETY: an out-parameter for an open handle.
            unsafe { GetFileInformationByHandle(held.0, &mut info) }
                .map_err(|e| failed(io::Error::other(e.to_string())))?;
            let attributes = info.dwFileAttributes;
            if attributes & FILE_ATTRIBUTE_DIRECTORY.0 == 0
                || attributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0
                || !owned_by_me(held.0).map_err(|e| failed(io::Error::other(e)))?
            {
                return Err(not_owned(&user, &label));
            }
            Ok(Folder {
                _held: held,
                path,
                label,
                user,
            })
        }

        fn options() -> OpenOptions {
            let mut options = OpenOptions::new();
            options.custom_flags(NO_REPARSE);
            options
        }

        pub fn create(&self, name: &str) -> io::Result<File> {
            Self::options()
                .write(true)
                .create_new(true)
                .open(self.path.join(name))
        }

        pub fn open_existing(&self, name: &str, write: bool) -> io::Result<File> {
            let file = Self::options()
                .read(!write)
                .write(write)
                .open(self.path.join(name))?;
            let metadata = file.metadata()?;
            if !metadata.is_file() {
                return Err(io::Error::from(io::ErrorKind::InvalidInput));
            }
            Ok(file)
        }

        pub fn remove(&self, name: &str) -> io::Result<()> {
            std::fs::remove_file(self.path.join(name))
        }

        /// Without `MOVEFILE_REPLACE_EXISTING`, an existing name fails.
        pub fn rename_new(&self, from: &str, to: &str) -> io::Result<()> {
            let (from, to) = (wide(&self.path.join(from)), wide(&self.path.join(to)));
            // SAFETY: NUL-terminated paths.
            unsafe {
                MoveFileExW(
                    PCWSTR(from.as_ptr()),
                    PCWSTR(to.as_ptr()),
                    MOVE_FILE_FLAGS(0),
                )
            }
            .map_err(|e| {
                let code = e.code().0 & 0xffff;
                // ERROR_FILE_EXISTS, ERROR_ALREADY_EXISTS
                if code == 80 || code == 183 {
                    io::Error::from(io::ErrorKind::AlreadyExists)
                } else {
                    io::Error::from_raw_os_error(code)
                }
            })
        }

        /// Free bytes for this process's user (quotas count).
        pub fn free(&self) -> io::Result<u64> {
            let path = wide(&self.path);
            let mut free = 0u64;
            // SAFETY: a NUL-terminated path and an out-parameter.
            unsafe { GetDiskFreeSpaceExW(PCWSTR(path.as_ptr()), Some(&mut free), None, None) }
                .map_err(|e| io::Error::other(e.to_string()))?;
            Ok(free)
        }

        pub fn names(&self) -> io::Result<Vec<String>> {
            Ok(std::fs::read_dir(&self.path)?
                .flatten()
                .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
                .collect())
        }

        /// Saved files inherit the Downloads folder's permissions.
        pub fn make_private(_file: &File) -> io::Result<()> {
            Ok(())
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// SF4: the download folder per system.
    #[test]
    fn sf4_the_download_folder_per_system() {
        let home = Path::new("/home/kim");
        let read = |text: &str| linux_downloads(home, Some(text));
        assert_eq!(
            read("# comment\nXDG_DESKTOP_DIR=\"$HOME/Desktop\"\nXDG_DOWNLOAD_DIR=\"$HOME/Téléchargements\"\n"),
            PathBuf::from("/home/kim/Téléchargements")
        );
        assert_eq!(
            read("XDG_DOWNLOAD_DIR=\"/data/kim/dl\""),
            PathBuf::from("/data/kim/dl")
        );
        for fallback in [
            "",
            "XDG_DESKTOP_DIR=\"$HOME/Desktop\"",
            "XDG_DOWNLOAD_DIR=\"$HOME\"",
            "XDG_DOWNLOAD_DIR=\"$HOME/\"",
            "XDG_DOWNLOAD_DIR=\"$(rm -rf ~)\"",
            "XDG_DOWNLOAD_DIR=\"$HOME/$OTHER\"",
            "XDG_DOWNLOAD_DIR=\"$HOMEX/a\"",
            "XDG_DOWNLOAD_DIR=\"relative/dl\"",
            "XDG_DOWNLOAD_DIR=\"$HOME/../other\"",
            "XDG_DOWNLOAD_DIR=$HOME/NoQuotes",
        ] {
            assert_eq!(
                read(fallback),
                PathBuf::from("/home/kim/Downloads"),
                "{fallback}"
            );
        }
        assert_eq!(
            linux_downloads(home, None),
            PathBuf::from("/home/kim/Downloads")
        );
        assert_eq!(
            label(Path::new("/home/kim/Téléchargements"), home, '/'),
            "Téléchargements/BMuster"
        );
        assert_eq!(
            label(Path::new("/data/kim/dl"), home, '/'),
            "/data/kim/dl/BMuster"
        );
        assert_eq!(
            label(
                Path::new("C:/Users/kim/Downloads"),
                Path::new("C:/Users/kim"),
                '\\'
            ),
            "Downloads\\BMuster"
        );

        // Downloads and BMuster are made when missing, private to the person.
        let dir = tempfile::tempdir().unwrap();
        let downloads = dir.path().join("home/Downloads");
        let folder = Folder::open(&downloads, "Downloads/BMuster".into(), "kim".into()).unwrap();
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(downloads.join("BMuster"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);
        assert!(folder.free().unwrap() > 0);
    }

    /// SF5: a link, a file or a moved folder never receives files.
    #[test]
    fn sf5_links_and_foreign_folders_are_refused() {
        let dir = tempfile::tempdir().unwrap();
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        let downloads = dir.path().join("Downloads");
        std::fs::create_dir(&downloads).unwrap();
        std::os::unix::fs::symlink(&elsewhere, downloads.join("BMuster")).unwrap();
        let refused = Folder::open(&downloads, "Downloads/BMuster".into(), "Kim".into())
            .err()
            .unwrap();
        assert_eq!(refused.code, UserFilesError::NotOwned);
        assert_eq!(
            refused.message,
            "Kim's Downloads/BMuster is not an ordinary folder they own, so nothing was saved. Rename or remove it on the machine."
        );
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);

        std::fs::remove_file(downloads.join("BMuster")).unwrap();
        std::fs::write(downloads.join("BMuster"), b"a file").unwrap();
        let refused = Folder::open(&downloads, "Downloads/BMuster".into(), "Kim".into())
            .err()
            .unwrap();
        assert_eq!(refused.code, UserFilesError::NotOwned);

        // Opened, then swapped for a link: files still go to the folder opened.
        std::fs::remove_file(downloads.join("BMuster")).unwrap();
        let folder = Folder::open(&downloads, "Downloads/BMuster".into(), "Kim".into()).unwrap();
        std::fs::rename(downloads.join("BMuster"), dir.path().join("moved")).unwrap();
        std::os::unix::fs::symlink(&elsewhere, downloads.join("BMuster")).unwrap();
        drop(folder.create("a.txt").unwrap());
        assert!(dir.path().join("moved/a.txt").exists());
        assert_eq!(std::fs::read_dir(&elsewhere).unwrap().count(), 0);
        // A link inside the folder is never followed.
        std::os::unix::fs::symlink(elsewhere.join("t"), dir.path().join("moved/link")).unwrap();
        assert!(folder.create("link").is_err());
        assert!(folder.open_existing("link", true).is_err());
        assert!(!elsewhere.join("t").exists());
    }
}
