//! Which paths and names a file session accepts (SPEC-FILES F4).
//!
//! The agent runs as root or SYSTEM, so this is about doing exactly what the
//! person meant, not a sandbox: a path is absolute and has no `.` or `..`
//! parts; a name is one part; Windows device paths (`\\.\`, `\\?\`), UNC
//! paths, reserved device names (CON, NUL, COM1…) and alternate data streams
//! (`name:stream`) are refused. The rules are written for both platforms so
//! both are tested everywhere; [`HOST`] is the one that applies.

use super::FileError;
use std::path::PathBuf;

/// Whose path rules apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavour {
    Unix,
    Windows,
}

/// This machine's rules.
pub const HOST: Flavour = if cfg!(windows) {
    Flavour::Windows
} else {
    Flavour::Unix
};

/// Longest path and name accepted, in bytes.
const MAX_PATH_BYTES: usize = 4096;
const MAX_NAME_BYTES: usize = 255;

/// Whether a name is for something that already exists (it only has to
/// name it) or for something about to be made (it must be a safe new name).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameUse {
    Existing,
    New,
}

const WINDOWS_RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];

/// CON, NUL, COM1, LPT¹… with or without an extension, any case.
fn is_windows_reserved(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or("").trim_end_matches(' ');
    let upper = stem.to_ascii_uppercase();
    if WINDOWS_RESERVED.contains(&upper.as_str()) || upper == "CONIN$" || upper == "CONOUT$" {
        return true;
    }
    for prefix in ["COM", "LPT"] {
        if let Some(rest) = upper.strip_prefix(prefix) {
            if matches!(
                rest,
                "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
            ) || matches!(rest, "\u{b9}" | "\u{b2}" | "\u{b3}")
            {
                return true;
            }
        }
    }
    false
}

/// Checks one name: a single part of a path.
pub fn check_name(flavour: Flavour, name: &str, use_: NameUse) -> Result<(), FileError> {
    let refuse = |why: &str| Err(FileError::invalid(format!("“{name}” {why}")));
    if name.is_empty() {
        return Err(FileError::invalid("A name cannot be empty.".into()));
    }
    if name.len() > MAX_NAME_BYTES {
        return refuse("is too long.");
    }
    if name == "." || name == ".." {
        return refuse("is not a name.");
    }
    if name.contains('\0') || name.contains('/') {
        return refuse("must be one name, not a path.");
    }
    let strict = flavour == Flavour::Windows || use_ == NameUse::New;
    if !strict {
        return Ok(());
    }
    if name.contains('\\') {
        return refuse("must be one name, not a path.");
    }
    if name.contains(':') {
        return refuse("cannot contain a colon.");
    }
    if name.chars().any(char::is_control) {
        return refuse("cannot contain control characters.");
    }
    if flavour == Flavour::Windows {
        if name
            .chars()
            .any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
        {
            return refuse("cannot contain < > \" | ? or *.");
        }
        if name.ends_with('.') || name.ends_with(' ') {
            return refuse("cannot end with a dot or a space on Windows.");
        }
        if is_windows_reserved(name) {
            return refuse("is a reserved device name on Windows.");
        }
    }
    Ok(())
}

/// Checks an absolute path from the server and returns it as a `PathBuf`.
pub fn check_path(flavour: Flavour, path: &str) -> Result<PathBuf, FileError> {
    let refuse = |why: &str| Err(FileError::invalid(format!("“{path}” {why}")));
    if path.len() > MAX_PATH_BYTES {
        return refuse("is too long.");
    }
    if path.contains('\0') {
        return refuse("is not a path.");
    }
    let parts: Vec<&str> = match flavour {
        Flavour::Unix => {
            let Some(rest) = path.strip_prefix('/') else {
                return refuse("is not an absolute path.");
            };
            rest.split('/').filter(|part| !part.is_empty()).collect()
        }
        Flavour::Windows => {
            if path.starts_with(r"\\") || path.starts_with("//") {
                return refuse("is a network or device path, which Files does not open.");
            }
            let bytes = path.as_bytes();
            let drive = bytes.len() >= 3
                && bytes[0].is_ascii_alphabetic()
                && bytes[1] == b':'
                && (bytes[2] == b'\\' || bytes[2] == b'/');
            if !drive {
                return refuse("is not an absolute path (it must start with a drive, like C:\\).");
            }
            path[3..]
                .split(['\\', '/'])
                .filter(|part| !part.is_empty())
                .collect()
        }
    };
    for part in &parts {
        if *part == "." || *part == ".." {
            return refuse("must not contain . or .. parts.");
        }
        if flavour == Flavour::Windows {
            check_name(flavour, part, NameUse::Existing)?;
        }
    }
    Ok(PathBuf::from(path))
}

/// `dir` joined with `name`, both checked.
pub fn child(flavour: Flavour, dir: &str, name: &str, use_: NameUse) -> Result<PathBuf, FileError> {
    let dir = check_path(flavour, dir)?;
    check_name(flavour, name, use_)?;
    Ok(dir.join(name))
}

/// A path as text for replies and the audit (lossy only for names that are
/// not valid Unicode, which the console cannot show exactly anyway).
pub fn display(path: &std::path::Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use bmuster_protocol::files::ErrorCode;

    fn refused_path(flavour: Flavour, path: &str) -> bool {
        matches!(check_path(flavour, path), Err(e) if e.code == ErrorCode::Invalid)
    }

    fn refused_name(flavour: Flavour, name: &str, use_: NameUse) -> bool {
        matches!(check_name(flavour, name, use_), Err(e) if e.code == ErrorCode::Invalid)
    }

    #[test]
    fn unix_paths_must_be_absolute_without_dot_parts() {
        assert!(check_path(Flavour::Unix, "/").is_ok());
        assert!(check_path(Flavour::Unix, "/home/kim/My Files").is_ok());
        assert!(check_path(Flavour::Unix, "/sys/bus/pci/devices/0000:00:01.0").is_ok());
        for bad in [
            "",
            "home/kim",
            "./x",
            "/home/../etc",
            "/home/./kim",
            "/a\0b",
        ] {
            assert!(refused_path(Flavour::Unix, bad), "{bad:?}");
        }
    }

    #[test]
    fn windows_paths_need_a_drive_and_refuse_devices_and_unc() {
        assert!(check_path(Flavour::Windows, r"C:\").is_ok());
        assert!(check_path(Flavour::Windows, r"C:\Users\Public\Downloads").is_ok());
        assert!(check_path(Flavour::Windows, "D:/Data").is_ok());
        for bad in [
            r"\\.\PhysicalDrive0",
            r"\\?\GLOBALROOT\Device\HarddiskVolume1",
            r"\\?\C:\Windows",
            r"\\server\share\file.txt",
            "//server/share",
            r"C:relative",
            r"\Windows",
            r"Windows\System32",
            r"C:\Users\..\Windows",
            r"C:\temp\file.txt:secret",
            r"C:\temp\CON",
            r"C:\temp\nul.txt",
            r"C:\temp\COM1",
        ] {
            assert!(refused_path(Flavour::Windows, bad), "{bad:?}");
        }
    }

    #[test]
    fn a_name_is_one_part() {
        for flavour in [Flavour::Unix, Flavour::Windows] {
            for use_ in [NameUse::Existing, NameUse::New] {
                for bad in ["", ".", "..", "a/b", "a\0b", &"x".repeat(256)] {
                    assert!(refused_name(flavour, bad, use_), "{flavour:?} {bad:?}");
                }
                assert!(check_name(flavour, "report 2026.pdf", use_).is_ok());
                assert!(check_name(flavour, ".hidden", use_).is_ok());
            }
            for bad in [r"a\b", "file.txt:stream", "line\nbreak", "..\\up"] {
                assert!(
                    refused_name(flavour, bad, NameUse::New),
                    "{flavour:?} {bad:?}"
                );
            }
        }
    }

    #[test]
    fn existing_unix_names_may_hold_any_character_but_a_slash() {
        assert!(check_name(Flavour::Unix, "0000:00:01.0", NameUse::Existing).is_ok());
        assert!(check_name(Flavour::Unix, r"back\slash", NameUse::Existing).is_ok());
        assert!(refused_name(Flavour::Unix, "0000:00:01.0", NameUse::New));
    }

    #[test]
    fn windows_reserved_names_are_refused_in_any_case() {
        for bad in [
            "CON",
            "con",
            "Nul.txt",
            "PRN",
            "aux.log",
            "COM1",
            "com9.dat",
            "LPT3",
            "CONIN$",
            "COM\u{b9}",
            "nul ",
            "name.",
            "a*b",
            "a?b",
            "a|b",
            "a\"b",
            "a<b",
        ] {
            assert!(
                refused_name(Flavour::Windows, bad, NameUse::Existing),
                "{bad:?}"
            );
        }
        for good in ["CONSOLE.txt", "COM10", "nullable", "LPT"] {
            assert!(
                check_name(Flavour::Windows, good, NameUse::New).is_ok(),
                "{good:?}"
            );
        }
        assert!(check_name(Flavour::Unix, "CON", NameUse::New).is_ok());
    }

    #[test]
    fn child_checks_both_parts() {
        assert_eq!(
            child(Flavour::Unix, "/srv", "a.txt", NameUse::New).unwrap(),
            PathBuf::from("/srv/a.txt")
        );
        assert!(child(Flavour::Unix, "srv", "a.txt", NameUse::New).is_err());
        assert!(child(Flavour::Unix, "/srv", "../etc", NameUse::Existing).is_err());
    }
}
