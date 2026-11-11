//! One drive's scan on disk (SPEC-STORAGE 4): a compact file of our own.
//!
//! Layout: [`MAGIC`], the header, the kept folders in pre-order (each with
//! its child count), the largest files, then a SHA-256 of everything before
//! it. Numbers are little-endian; text is a u32 length and UTF-8 bytes. A
//! file that is short, damaged or of another version is refused.
//!
//! Saving writes `<name>.tmp` (owner-only), flushes it and renames it over
//! the scan, so a half-written scan never replaces the last complete one.

use super::walk::{Folder, LargeFile, Walked};
use anyhow::{bail, Context as _, Result};
use sha2::{Digest as _, Sha256};
use std::path::Path;

const MAGIC: &[u8; 8] = b"BMSTOR\x00\x01";
const HASH_BYTES: usize = 32;
/// Deeper than any real path: a file claiming more is damaged.
const MAX_DEPTH: usize = 4096;

/// A drive's last complete scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scan {
    pub mount: String,
    pub started_at_ms: i64,
    pub finished_at_ms: i64,
    pub size_bytes: u64,
    pub used_bytes: u64,
    pub folders: u64,
    pub denied: u64,
    pub root: Folder,
    pub largest: Vec<LargeFile>,
}

impl Scan {
    pub fn new(
        mount: String,
        started_at_ms: i64,
        finished_at_ms: i64,
        space: (u64, u64),
        walked: Walked,
    ) -> Self {
        Self {
            mount,
            started_at_ms,
            finished_at_ms,
            size_bytes: space.0,
            used_bytes: space.1,
            folders: walked.folders,
            denied: walked.denied,
            root: walked.root,
            largest: walked.largest,
        }
    }
}

struct Writer(Vec<u8>);

impl Writer {
    fn u64(&mut self, value: u64) {
        self.0.extend_from_slice(&value.to_le_bytes());
    }
    fn i64(&mut self, value: i64) {
        self.0.extend_from_slice(&value.to_le_bytes());
    }
    fn text(&mut self, text: &str) {
        let length = u32::try_from(text.len()).unwrap_or(u32::MAX);
        self.0.extend_from_slice(&length.to_le_bytes());
        self.0
            .extend_from_slice(&text.as_bytes()[..length as usize]);
    }
    fn folder(&mut self, folder: &Folder) {
        self.text(&folder.name);
        for value in [
            folder.bytes,
            folder.files,
            folder.own_bytes,
            folder.own_files,
            folder.folded_folders,
            folder.folded_bytes,
            folder.children.len() as u64,
        ] {
            self.u64(value);
        }
        for child in &folder.children {
            self.folder(child);
        }
    }
}

struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn take(&mut self, count: usize) -> Result<&[u8]> {
        if self.0.len() < count {
            bail!("the scan file ends early");
        }
        let (head, rest) = self.0.split_at(count);
        self.0 = rest;
        Ok(head)
    }
    fn u64(&mut self) -> Result<u64> {
        let bytes: [u8; 8] = self.take(8)?.try_into()?;
        Ok(u64::from_le_bytes(bytes))
    }
    fn i64(&mut self) -> Result<i64> {
        let bytes: [u8; 8] = self.take(8)?.try_into()?;
        Ok(i64::from_le_bytes(bytes))
    }
    fn text(&mut self) -> Result<String> {
        let bytes: [u8; 4] = self.take(4)?.try_into()?;
        let length = u32::from_le_bytes(bytes) as usize;
        Ok(String::from_utf8(self.take(length)?.to_vec())?)
    }
    fn folder(&mut self, depth: usize) -> Result<Folder> {
        if depth > MAX_DEPTH {
            bail!("the scan file's folders are nested too deep");
        }
        let name = self.text()?;
        let mut numbers = [0u64; 7];
        for number in &mut numbers {
            *number = self.u64()?;
        }
        let [bytes, files, own_bytes, own_files, folded_folders, folded_bytes, count] = numbers;
        // Each child takes at least 60 bytes: a count past that is damage.
        if count > (self.0.len() / 60) as u64 {
            bail!("the scan file claims more folders than it holds");
        }
        let mut children = Vec::with_capacity(count as usize);
        for _ in 0..count {
            children.push(self.folder(depth + 1)?);
        }
        Ok(Folder {
            name,
            bytes,
            files,
            own_bytes,
            own_files,
            folded_folders,
            folded_bytes,
            children,
        })
    }
}

/// The scan as bytes.
pub fn encode(scan: &Scan) -> Vec<u8> {
    let mut writer = Writer(MAGIC.to_vec());
    writer.text(&scan.mount);
    writer.i64(scan.started_at_ms);
    writer.i64(scan.finished_at_ms);
    for value in [scan.size_bytes, scan.used_bytes, scan.folders, scan.denied] {
        writer.u64(value);
    }
    writer.folder(&scan.root);
    writer.u64(scan.largest.len() as u64);
    for file in &scan.largest {
        writer.text(&file.path);
        writer.u64(file.bytes);
        match file.modified_ms {
            Some(ms) => {
                writer.0.push(1);
                writer.i64(ms);
            }
            None => writer.0.push(0),
        }
    }
    let hash = Sha256::digest(&writer.0);
    writer.0.extend_from_slice(&hash);
    writer.0
}

/// A scan from bytes, refused when damaged.
pub fn decode(bytes: &[u8]) -> Result<Scan> {
    if bytes.len() < MAGIC.len() + HASH_BYTES || !bytes.starts_with(MAGIC) {
        bail!("not a scan file of this version");
    }
    let (body, hash) = bytes.split_at(bytes.len() - HASH_BYTES);
    if Sha256::digest(body).as_slice() != hash {
        bail!("the scan file is damaged (its checksum does not match)");
    }
    let mut reader = Reader(&body[MAGIC.len()..]);
    let mount = reader.text()?;
    let started_at_ms = reader.i64()?;
    let finished_at_ms = reader.i64()?;
    let size_bytes = reader.u64()?;
    let used_bytes = reader.u64()?;
    let folders = reader.u64()?;
    let denied = reader.u64()?;
    let root = reader.folder(0)?;
    let count = reader.u64()?;
    if count > super::walk::MAX_LARGEST as u64 {
        bail!("the scan file holds too many files");
    }
    let mut largest = Vec::with_capacity(count as usize);
    for _ in 0..count {
        let path = reader.text()?;
        let bytes = reader.u64()?;
        let modified_ms = match reader.take(1)?[0] {
            0 => None,
            _ => Some(reader.i64()?),
        };
        largest.push(LargeFile {
            bytes,
            path,
            modified_ms,
        });
    }
    if !reader.0.is_empty() {
        bail!("the scan file has bytes after its end");
    }
    Ok(Scan {
        mount,
        started_at_ms,
        finished_at_ms,
        size_bytes,
        used_bytes,
        folders,
        denied,
        root,
        largest,
    })
}

/// Saves `scan` at `path` through a temporary file and a rename.
pub fn save(path: &Path, scan: &Scan) -> Result<()> {
    crate::identity::write_private(path, &encode(scan))
}

/// The scan at `path`; `None` when there is none.
pub fn load(path: &Path) -> Result<Option<Scan>> {
    match std::fs::read(path) {
        Ok(bytes) => decode(&bytes)
            .map(Some)
            .with_context(|| format!("could not read {}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("could not read {}", path.display())),
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// `/` with `var` (holding `log`) and `home`, and two large files.
    pub fn sample() -> Scan {
        let log = Folder {
            name: "log".into(),
            bytes: 600,
            files: 3,
            own_bytes: 600,
            own_files: 3,
            ..Folder::default()
        };
        let var = Folder {
            name: "var".into(),
            bytes: 700,
            files: 5,
            own_bytes: 50,
            own_files: 1,
            folded_folders: 2,
            folded_bytes: 50,
            children: vec![log],
        };
        let home = Folder {
            name: "home".into(),
            bytes: 300,
            files: 2,
            own_bytes: 300,
            own_files: 2,
            ..Folder::default()
        };
        Scan {
            mount: "/".into(),
            started_at_ms: 1_000,
            finished_at_ms: 2_000,
            size_bytes: 10_000,
            used_bytes: 1_500,
            folders: 6,
            denied: 1,
            root: Folder {
                name: "/".into(),
                bytes: 1_000,
                files: 7,
                children: vec![var, home],
                ..Folder::default()
            },
            largest: vec![
                LargeFile {
                    bytes: 400,
                    path: "/var/log/syslog".into(),
                    modified_ms: Some(5),
                },
                LargeFile {
                    bytes: 200,
                    path: "/home/a.iso".into(),
                    modified_ms: None,
                },
            ],
        }
    }

    #[test]
    fn s4_a_scan_round_trips() {
        let scan = sample();
        assert_eq!(decode(&encode(&scan)).unwrap(), scan);
    }

    #[test]
    fn s4_damaged_or_short_files_are_refused() {
        let bytes = encode(&sample());
        let mut flipped = bytes.clone();
        flipped[20] ^= 1;
        assert!(decode(&flipped).is_err());
        assert!(decode(&bytes[..bytes.len() - 1]).is_err());
        assert!(decode(b"BMSTOR").is_err());
        assert!(decode(&[]).is_err());
        let mut other = bytes;
        other[7] = 9;
        assert!(decode(&other).is_err());
    }

    #[test]
    fn s4_saving_replaces_through_a_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("abc.scan");
        assert_eq!(load(&path).unwrap(), None);
        save(&path, &sample()).unwrap();
        assert_eq!(load(&path).unwrap(), Some(sample()));
        assert!(!dir.path().join("abc.tmp").exists());
        // A save that cannot finish (its temporary name is taken by a folder
        // it cannot remove) leaves the previous scan as it was.
        std::fs::create_dir(dir.path().join("abc.tmp")).unwrap();
        std::fs::write(dir.path().join("abc.tmp/keep"), b"x").unwrap();
        let mut newer = sample();
        newer.finished_at_ms = 9_999;
        assert!(save(&path, &newer).is_err());
        assert_eq!(load(&path).unwrap(), Some(sample()));
    }
}
