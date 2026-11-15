//! File lists on the clipboard (SPEC-SESSION-FILES 4.6, phase 2): the
//! standard formats, written and read the same on every Linux route.
//!
//! - `text/uri-list` (RFC 2483): one `file://` URI per line, CRLF, each
//!   byte outside the unreserved set percent-encoded.
//! - `x-special/gnome-copied-files`: `copy`, then the same URIs, one per
//!   line (GNOME, Nemo, Caja, Thunar read it; a cut says `cut`, which
//!   BMuster treats as a copy and never removes the originals).
//!
//! Reading is strict: only the `file:` scheme with an empty host or
//! `localhost`, percent-decoded to bytes, absolute paths; anything else is
//! an item that is not on this machine's disks.

use std::path::PathBuf;

/// The two Linux types, in the order offered and asked for.
pub const URI_LIST: &str = "text/uri-list";
pub const GNOME_COPIED_FILES: &str = "x-special/gnome-copied-files";

/// One entry of a copied file list.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CopiedItem {
    /// A path on this machine's disks (bytes: Linux paths need not be UTF-8).
    Local(PathBuf),
    /// Another scheme or host (`sftp://`, `smb://`, a portal URI).
    NotLocal,
}

/// `file://` and the path with every byte outside the unreserved set encoded.
pub fn file_uri(path: &[u8]) -> String {
    let mut uri = String::from("file://");
    for &byte in path {
        if byte.is_ascii_alphanumeric() || b"/-._~".contains(&byte) {
            uri.push(char::from(byte));
        } else {
            uri.push_str(&format!("%{byte:02X}"));
        }
    }
    uri
}

/// `text/uri-list` for these paths.
pub fn uri_list(paths: &[Vec<u8>]) -> String {
    paths
        .iter()
        .map(|path| format!("{}\r\n", file_uri(path)))
        .collect()
}

/// `x-special/gnome-copied-files` for these paths: always a copy.
pub fn gnome_copied_files(paths: &[Vec<u8>]) -> String {
    let uris: Vec<String> = paths.iter().map(|path| file_uri(path)).collect();
    format!("copy\n{}", uris.join("\n"))
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// One URI as an item: local only for `file:` with no host or `localhost`.
pub fn parse_uri(uri: &str) -> CopiedItem {
    let Some(rest) = uri.strip_prefix("file://") else {
        return CopiedItem::NotLocal;
    };
    let (host, path) = match rest.find('/') {
        Some(at) => rest.split_at(at),
        None => return CopiedItem::NotLocal,
    };
    if !host.is_empty() && !host.eq_ignore_ascii_case("localhost") {
        return CopiedItem::NotLocal;
    }
    let raw = path.as_bytes();
    let mut bytes = Vec::with_capacity(raw.len());
    let mut at = 0;
    while at < raw.len() {
        if raw[at] == b'%' {
            match (
                raw.get(at + 1).and_then(|b| hex(*b)),
                raw.get(at + 2).and_then(|b| hex(*b)),
            ) {
                (Some(high), Some(low)) => bytes.push(high * 16 + low),
                _ => return CopiedItem::NotLocal,
            }
            at += 3;
        } else {
            bytes.push(raw[at]);
            at += 1;
        }
    }
    if bytes.first() != Some(&b'/') || bytes.contains(&0) {
        return CopiedItem::NotLocal;
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt as _;
        CopiedItem::Local(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
    }
    #[cfg(not(unix))]
    {
        match String::from_utf8(bytes) {
            Ok(text) => CopiedItem::Local(PathBuf::from(text)),
            Err(_) => CopiedItem::NotLocal,
        }
    }
}

/// The items of a `text/uri-list` (comments and blank lines skipped) or
/// `x-special/gnome-copied-files` (its first line, `copy` or `cut`, skipped).
pub fn parse_list(mime: &str, text: &str) -> Vec<CopiedItem> {
    let lines = text.split(['\n', '\r']).map(str::trim);
    let lines: Vec<&str> = if mime == GNOME_COPIED_FILES {
        lines.skip(1).collect()
    } else {
        lines.collect()
    };
    lines
        .into_iter()
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(parse_uri)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SF21 (the Linux formats): percent-encoded URIs, CRLF for the URI
    /// list, `copy` first for GNOME.
    #[test]
    fn sf21_file_lists_serialise_per_system() {
        let paths = vec![
            b"/home/kim/Downloads/BMuster/report (2).pdf".to_vec(),
            "/home/kim/Téléchargements/BMuster/naïve.txt"
                .as_bytes()
                .to_vec(),
        ];
        assert_eq!(
            uri_list(&paths),
            "file:///home/kim/Downloads/BMuster/report%20%282%29.pdf\r\n\
             file:///home/kim/T%C3%A9l%C3%A9chargements/BMuster/na%C3%AFve.txt\r\n"
        );
        assert_eq!(
            gnome_copied_files(&paths[..1]),
            "copy\nfile:///home/kim/Downloads/BMuster/report%20%282%29.pdf"
        );
        // What BMuster writes it reads back unchanged.
        for (mime, text) in [
            (URI_LIST, uri_list(&paths)),
            (GNOME_COPIED_FILES, gnome_copied_files(&paths)),
        ] {
            let read = parse_list(mime, &text);
            assert_eq!(
                read,
                [
                    CopiedItem::Local(PathBuf::from("/home/kim/Downloads/BMuster/report (2).pdf")),
                    CopiedItem::Local(PathBuf::from("/home/kim/Téléchargements/BMuster/naïve.txt"))
                ],
                "{mime}"
            );
        }
    }

    /// SF23: only local `file:` URIs; everything else is not local.
    #[test]
    fn sf23_only_local_file_uris() {
        assert_eq!(
            parse_uri("file://localhost/etc/hosts"),
            CopiedItem::Local(PathBuf::from("/etc/hosts"))
        );
        assert_eq!(
            parse_uri("file:///tmp/a%2Fb"),
            CopiedItem::Local(PathBuf::from("/tmp/a/b")),
            "an encoded slash is just a slash in the path"
        );
        for other in [
            "sftp://server/home/kim/a.txt",
            "smb://nas/share/a.txt",
            "file://nas/share/a.txt",
            "file:relative.txt",
            "file:///tmp/%zz",
            "file:///tmp/%00x",
            "https://example.com/a.txt",
            "/home/kim/a.txt",
        ] {
            assert_eq!(parse_uri(other), CopiedItem::NotLocal, "{other}");
        }
        assert_eq!(
            parse_list(
                GNOME_COPIED_FILES,
                "cut\nfile:///home/kim/a.txt\nsmb://nas/b.txt\n"
            ),
            [
                CopiedItem::Local(PathBuf::from("/home/kim/a.txt")),
                CopiedItem::NotLocal
            ]
        );
        assert_eq!(
            parse_list(URI_LIST, "# a comment\r\n\r\nfile:///x\r\n"),
            [CopiedItem::Local(PathBuf::from("/x"))]
        );
    }
}
