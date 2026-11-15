//! Names of files sent from the browser (SPEC-SESSION-FILES 4.3, SF6, SF7).
//!
//! A name is one strict path part on every system, so a file saved on
//! Linux can go on to Windows: SPEC-FILES F4's new-name rules with the
//! Windows flavour (no `/`, `\`, `..`, NUL, `:`, control characters,
//! device names, trailing dots or spaces), at most 255 bytes. A name that
//! fails is refused with the reason, never cleaned up silently.
//!
//! A clash never overwrites: `report.pdf` becomes `report (2).pdf`, then
//! `report (3).pdf`; `README` becomes `README (2)`; `.bashrc` becomes
//! `.bashrc (2)`.

use super::UserError;
use crate::files::paths::{check_name, Flavour, NameUse};
use bmuster_protocol::files::PART_SUFFIX;

/// Longest name in bytes.
const MAX_NAME_BYTES: usize = 255;
/// The highest number tried before giving up.
pub const MAX_NUMBER: u32 = 999;

/// Checks a name the browser sent.
pub fn check(name: &str) -> Result<(), UserError> {
    check_name(Flavour::Windows, name, NameUse::New).map_err(|e| UserError::invalid(e.message))?;
    if name.ends_with(PART_SUFFIX) {
        return Err(UserError::invalid(format!(
            "“{name}” ends like BMuster's unfinished files."
        )));
    }
    Ok(())
}

/// The name with ` (n)` before its extension, for `n` from 2; within 255
/// bytes (the stem is shortened at a character boundary if need be).
pub fn numbered(name: &str, n: u32) -> String {
    if n < 2 {
        return name.to_string();
    }
    // A leading dot starts the name, not an extension (`.bashrc`).
    let (stem, extension) = match name.rfind('.') {
        Some(at) if at > 0 => name.split_at(at),
        _ => (name, ""),
    };
    let suffix = format!(" ({n})");
    let room = MAX_NAME_BYTES.saturating_sub(suffix.len() + extension.len());
    let mut cut = stem.len().min(room);
    while !stem.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}{suffix}{extension}", &stem[..cut])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SF6: one strict part on every system, with the reason.
    #[test]
    fn sf6_names_from_the_browser() {
        for good in [
            "report.pdf",
            "Ünïcödé 名前.txt",
            ".bashrc",
            "a b",
            "x".repeat(255).as_str(),
        ] {
            assert!(check(good).is_ok(), "{good}");
        }
        for (bad, why) in [
            ("", "empty"),
            ("..", "not a name"),
            (".", "not a name"),
            ("a/b", "one name"),
            ("a\\b", "one name"),
            ("a:b", "colon"),
            ("a\0b", "one name"),
            ("bell\u{7}", "control"),
            ("tab\there", "control"),
            ("CON", "reserved"),
            ("nul.txt", "reserved"),
            ("COM1", "reserved"),
            ("trailing.", "end with a dot"),
            ("trailing ", "end with a dot"),
            ("what?.txt", "cannot contain"),
            ("x.bmuster-part", "unfinished"),
        ] {
            let refused = check(bad).unwrap_err();
            assert_eq!(
                refused.code,
                bmuster_protocol::user_files::UserFilesError::Invalid
            );
            assert!(
                refused.message.contains(why),
                "{bad:?}: {}",
                refused.message
            );
        }
        assert!(check(&"x".repeat(256)).is_err());
    }

    /// SF7: the numbering; the never-overwriting rename is in `write`.
    #[test]
    fn sf7_clashes_get_a_number_and_never_overwrite() {
        assert_eq!(numbered("report.pdf", 1), "report.pdf");
        assert_eq!(numbered("report.pdf", 2), "report (2).pdf");
        assert_eq!(numbered("report.pdf", 3), "report (3).pdf");
        assert_eq!(numbered("README", 2), "README (2)");
        assert_eq!(numbered(".bashrc", 2), ".bashrc (2)");
        assert_eq!(numbered("archive.tar.gz", 2), "archive.tar (2).gz");
        let long = format!("{}.txt", "é".repeat(125));
        let made = numbered(&long, 999);
        assert!(made.len() <= 255, "{}", made.len());
        assert!(made.ends_with(" (999).txt"));
        assert!(check(&made).is_ok());
    }
}
