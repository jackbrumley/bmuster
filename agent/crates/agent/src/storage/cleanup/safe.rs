//! Deleting one listed entry where it was listed (SPEC-STORAGE 11.3).
//!
//! The sweep lists a folder, then deletes some of its entries. Between the
//! two, a person who owns the folder (their own temp or cache folder) could
//! swap it, or a folder above it, for a link to a system folder. Every
//! delete is therefore bound to what was checked:
//!
//! - Linux: the folder is opened with `O_NOFOLLOW | O_DIRECTORY`, its real
//!   path (`/proc/self/fd/N`) must be the listed folder, the entry must
//!   still be the same file (device and inode) and kind, and it is removed
//!   with `unlinkat` relative to that open folder.
//! - Windows: the entry is opened with `FILE_FLAG_OPEN_REPARSE_POINT` and
//!   `DELETE` access, must not be a reparse point, and its final path must
//!   be the listed path; it is deleted through that handle.

/// What happened to one entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Removal {
    Removed,
    /// Another program holds it open (Windows), or the system says busy.
    InUse,
    Denied,
    /// It moved, became a link, or is another file than the one listed.
    Changed,
    /// A folder that still has entries (kept).
    NotEmpty,
    Failed(String),
}

/// Whether the entry is a folder or a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Folder,
}

#[cfg(target_os = "linux")]
pub use linux::remove;

#[cfg(windows)]
pub use windows::remove;

/// Other systems have no agent build; nothing is ever deleted there.
#[cfg(not(any(target_os = "linux", windows)))]
pub fn remove(
    _folder: &std::path::Path,
    _name: &std::ffi::OsStr,
    _listed: &std::fs::Metadata,
    _kind: Kind,
) -> Removal {
    Removal::Failed("Clean-up is not available on this system.".into())
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{Kind, Removal};
    use std::ffi::{CString, OsStr};
    use std::fs::Metadata;
    use std::io;
    use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd};
    use std::os::unix::ffi::OsStrExt as _;
    use std::os::unix::fs::MetadataExt as _;
    use std::path::Path;

    fn c_string(bytes: &[u8]) -> io::Result<CString> {
        CString::new(bytes).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
    }

    /// `folder`, opened without following a link at its last part.
    fn open_folder(folder: &Path) -> io::Result<OwnedFd> {
        let path = c_string(folder.as_os_str().as_bytes())?;
        // SAFETY: `path` is a valid C string for the duration of the call.
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: `fd` was just opened and is owned by nobody else.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    /// Whether the open folder is really the listed one: a link anywhere
    /// above it would give another real path.
    fn is_listed_folder(fd: &OwnedFd, folder: &Path) -> bool {
        std::fs::read_link(format!("/proc/self/fd/{}", fd.as_raw_fd()))
            .is_ok_and(|real| real == folder)
    }

    /// Whether `name` in the open folder is still the listed entry.
    fn is_listed_entry(
        fd: &OwnedFd,
        name: &CString,
        listed: &Metadata,
        kind: Kind,
    ) -> io::Result<bool> {
        // SAFETY: an all-zero `stat` is a valid value to be overwritten.
        let mut now: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: `fd` is open, `name` is a valid C string and `now` is writable.
        let status = unsafe {
            libc::fstatat(
                fd.as_raw_fd(),
                name.as_ptr(),
                &mut now,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        };
        if status != 0 {
            return Err(io::Error::last_os_error());
        }
        let wanted = match kind {
            Kind::File => libc::S_IFREG,
            Kind::Folder => libc::S_IFDIR,
        };
        Ok(now.st_dev == listed.dev()
            && now.st_ino == listed.ino()
            && now.st_mode & libc::S_IFMT == wanted)
    }

    fn removal_of(error: &io::Error) -> Removal {
        match error.raw_os_error() {
            Some(libc::EACCES | libc::EPERM | libc::EROFS) => Removal::Denied,
            Some(libc::EBUSY | libc::ETXTBSY) => Removal::InUse,
            Some(libc::ENOENT | libc::ELOOP | libc::ENOTDIR) => Removal::Changed,
            Some(libc::ENOTEMPTY | libc::EEXIST) => Removal::NotEmpty,
            _ => Removal::Failed(error.to_string()),
        }
    }

    /// Deletes `name` in `folder` if it is still the listed entry there.
    /// `folder` must be the real path (no links) the sweep listed.
    pub fn remove(folder: &Path, name: &OsStr, listed: &Metadata, kind: Kind) -> Removal {
        let Ok(name) = c_string(name.as_bytes()) else {
            return Removal::Changed;
        };
        if name.as_bytes().contains(&b'/') {
            return Removal::Changed;
        }
        let fd = match open_folder(folder) {
            Ok(fd) => fd,
            Err(e) => return removal_of(&e),
        };
        if !is_listed_folder(&fd, folder) {
            return Removal::Changed;
        }
        match is_listed_entry(&fd, &name, listed, kind) {
            Ok(true) => {}
            Ok(false) => return Removal::Changed,
            Err(e) => return removal_of(&e),
        }
        let flags = match kind {
            Kind::File => 0,
            Kind::Folder => libc::AT_REMOVEDIR,
        };
        // SAFETY: `fd` is open and `name` is a valid C string with no slash.
        if unsafe { libc::unlinkat(fd.as_raw_fd(), name.as_ptr(), flags) } != 0 {
            return removal_of(&io::Error::last_os_error());
        }
        Removal::Removed
    }
}

#[cfg(windows)]
mod windows {
    use super::{Kind, Removal};
    use std::ffi::{c_void, OsStr, OsString};
    use std::fs::Metadata;
    use std::os::windows::ffi::{OsStrExt as _, OsStringExt as _};
    use std::path::Path;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_ACCESS_DENIED, ERROR_DIR_NOT_EMPTY, ERROR_FILE_NOT_FOUND,
        ERROR_INVALID_PARAMETER, ERROR_LOCK_VIOLATION, ERROR_NOT_SUPPORTED, ERROR_PATH_NOT_FOUND,
        ERROR_SHARING_VIOLATION, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FileAttributeTagInfo, FileDispositionInfo, FileDispositionInfoEx,
        GetFileInformationByHandleEx, GetFinalPathNameByHandleW, SetFileInformationByHandle,
        DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
        FILE_DISPOSITION_FLAG_DELETE, FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
        FILE_DISPOSITION_FLAG_POSIX_SEMANTICS, FILE_DISPOSITION_INFO, FILE_DISPOSITION_INFO_EX,
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_NAME_NORMALIZED,
        FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        VOLUME_NAME_DOS,
    };

    /// Closes the handle when dropped.
    struct Owned(HANDLE);

    impl Drop for Owned {
        fn drop(&mut self) {
            // SAFETY: the handle was opened by `CreateFileW` and is closed once.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    fn removal_of(code: u32) -> Removal {
        match code {
            ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION => Removal::InUse,
            ERROR_ACCESS_DENIED => Removal::Denied,
            ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => Removal::Changed,
            ERROR_DIR_NOT_EMPTY => Removal::NotEmpty,
            other => {
                Removal::Failed(std::io::Error::from_raw_os_error(other.cast_signed()).to_string())
            }
        }
    }

    fn last_error() -> u32 {
        // SAFETY: reads the calling thread's last error.
        unsafe { GetLastError() }
    }

    /// The path the handle really names (`\\?\C:\…`).
    fn final_path(handle: HANDLE) -> Option<OsString> {
        let mut buffer = vec![0u16; 32_768];
        let capacity = u32::try_from(buffer.len()).ok()?;
        // SAFETY: `buffer` holds `capacity` writable u16s.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                handle,
                buffer.as_mut_ptr(),
                capacity,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        };
        let length = usize::try_from(length).ok()?;
        (length > 0 && length < buffer.len()).then(|| OsString::from_wide(&buffer[..length]))
    }

    fn same_path(a: &OsStr, b: &OsStr) -> bool {
        a == b || a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    }

    fn mark_deleted(handle: HANDLE) -> Result<(), u32> {
        let ex = FILE_DISPOSITION_INFO_EX {
            Flags: FILE_DISPOSITION_FLAG_DELETE
                | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS
                | FILE_DISPOSITION_FLAG_IGNORE_READONLY_ATTRIBUTE,
        };
        // SAFETY: `ex` is a valid FILE_DISPOSITION_INFO_EX of the size given.
        let done = unsafe {
            SetFileInformationByHandle(
                handle,
                FileDispositionInfoEx,
                std::ptr::from_ref(&ex).cast::<c_void>(),
                size_of::<FILE_DISPOSITION_INFO_EX>() as u32,
            )
        };
        if done != 0 {
            return Ok(());
        }
        let code = last_error();
        if code != ERROR_INVALID_PARAMETER && code != ERROR_NOT_SUPPORTED {
            return Err(code);
        }
        // Before Windows 10 1809, or a file system without the extended form.
        let plain = FILE_DISPOSITION_INFO { DeleteFile: true };
        // SAFETY: `plain` is a valid FILE_DISPOSITION_INFO of the size given.
        let done = unsafe {
            SetFileInformationByHandle(
                handle,
                FileDispositionInfo,
                std::ptr::from_ref(&plain).cast::<c_void>(),
                size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        };
        if done == 0 {
            Err(last_error())
        } else {
            Ok(())
        }
    }

    /// Deletes `folder\name` if it is still the listed, non-link entry there.
    /// `folder` must be the final path (`\\?\C:\…`) the sweep listed.
    pub fn remove(folder: &Path, name: &OsStr, _listed: &Metadata, kind: Kind) -> Removal {
        let path = folder.join(name);
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let flags = FILE_FLAG_OPEN_REPARSE_POINT
            | match kind {
                Kind::File => 0,
                Kind::Folder => FILE_FLAG_BACKUP_SEMANTICS,
            };
        // SAFETY: `wide` is a NUL-terminated UTF-16 path.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                DELETE | FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                flags,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return removal_of(last_error());
        }
        let handle = Owned(handle);
        let mut tag = FILE_ATTRIBUTE_TAG_INFO {
            FileAttributes: 0,
            ReparseTag: 0,
        };
        // SAFETY: `tag` is a writable FILE_ATTRIBUTE_TAG_INFO of the size given.
        let read = unsafe {
            GetFileInformationByHandleEx(
                handle.0,
                FileAttributeTagInfo,
                std::ptr::from_mut(&mut tag).cast::<c_void>(),
                size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        };
        if read == 0 {
            return removal_of(last_error());
        }
        let is_folder = tag.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
        if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
            || is_folder != (kind == Kind::Folder)
        {
            return Removal::Changed;
        }
        match final_path(handle.0) {
            Some(real) if same_path(&real, path.as_os_str()) => {}
            _ => return Removal::Changed,
        }
        match mark_deleted(handle.0) {
            Ok(()) => Removal::Removed,
            Err(code) => removal_of(code),
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::fs::{self, Metadata};
    use std::path::Path;

    fn listed(path: &Path) -> Metadata {
        fs::symlink_metadata(path).unwrap()
    }

    #[test]
    fn s13_removes_the_listed_file_and_an_emptied_folder() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::create_dir(root.join("sub")).unwrap();
        fs::write(root.join("sub/a"), b"a").unwrap();
        let file = listed(&root.join("sub/a"));
        assert_eq!(
            remove(&root.join("sub"), OsStr::new("a"), &file, Kind::File),
            Removal::Removed
        );
        let folder = listed(&root.join("sub"));
        assert_eq!(
            remove(&root, OsStr::new("sub"), &folder, Kind::Folder),
            Removal::Removed
        );
        assert!(!root.join("sub").exists());
    }

    #[test]
    fn s13_a_folder_swapped_for_a_link_after_listing_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let outside = root.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("precious"), b"keep").unwrap();
        fs::create_dir_all(root.join("tmp/cache")).unwrap();
        fs::write(root.join("tmp/cache/precious"), b"junk").unwrap();
        let file = listed(&root.join("tmp/cache/precious"));

        // The last part becomes a link: refused by O_NOFOLLOW.
        fs::rename(root.join("tmp/cache"), root.join("tmp/moved")).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("tmp/cache")).unwrap();
        assert_eq!(
            remove(
                &root.join("tmp/cache"),
                OsStr::new("precious"),
                &file,
                Kind::File
            ),
            Removal::Changed
        );

        // A part above becomes a link: refused by the real-path check.
        fs::remove_file(root.join("tmp/cache")).unwrap();
        fs::rename(root.join("tmp"), root.join("tmp-moved")).unwrap();
        fs::create_dir(root.join("elsewhere")).unwrap();
        fs::create_dir(root.join("elsewhere/cache")).unwrap();
        fs::write(root.join("elsewhere/cache/precious"), b"keep").unwrap();
        std::os::unix::fs::symlink(root.join("elsewhere"), root.join("tmp")).unwrap();
        assert_eq!(
            remove(
                &root.join("tmp/cache"),
                OsStr::new("precious"),
                &file,
                Kind::File
            ),
            Removal::Changed
        );
        assert!(outside.join("precious").exists());
        assert!(root.join("elsewhere/cache/precious").exists());
    }

    #[test]
    fn s13_a_file_replaced_since_listing_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        fs::write(root.join("a"), b"old").unwrap();
        let file = listed(&root.join("a"));
        // The listed file moves away (keeping its inode) and another takes its name.
        fs::rename(root.join("a"), root.join("kept")).unwrap();
        fs::write(root.join("a"), b"new").unwrap();
        assert_eq!(
            remove(&root, OsStr::new("a"), &file, Kind::File),
            Removal::Changed
        );
        assert!(root.join("a").exists());
        assert_eq!(
            remove(&root, OsStr::new("gone"), &file, Kind::File),
            Removal::Changed
        );
        assert_eq!(
            remove(&root, OsStr::new("../a"), &file, Kind::File),
            Removal::Changed
        );
    }
}
