//! An append-only log file that is moved aside once it grows too big.

use std::fs::{File, OpenOptions};
use std::path::Path;

/// Above this size the log is moved to `<name>.log.old` when it is opened.
pub const MAX_LOG_BYTES: u64 = 10 * 1024 * 1024;

/// Opens `path` for appending, first moving it to `<name>.log.old` when it
/// is over [`MAX_LOG_BYTES`] (replacing an older `.old`).
pub fn open_rotated(path: &Path) -> Result<File, String> {
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_LOG_BYTES {
            std::fs::rename(path, path.with_extension("log.old"))
                .map_err(|e| format!("could not rotate {}: {e}", path.display()))?;
        }
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("could not open the log file {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    #[test]
    fn a_big_log_is_moved_aside_and_a_small_one_appended_to() {
        let dir = std::env::temp_dir().join(format!("bmuster-log-file-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("server.log");

        open_rotated(&path).unwrap().write_all(b"first\n").unwrap();
        open_rotated(&path).unwrap().write_all(b"second\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first\nsecond\n");

        std::fs::write(&path, vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        open_rotated(&path).unwrap().write_all(b"fresh\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "fresh\n");
        assert_eq!(
            std::fs::metadata(dir.join("server.log.old")).unwrap().len(),
            MAX_LOG_BYTES + 1
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
