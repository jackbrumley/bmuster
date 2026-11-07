//! The Node command line the launcher runs (SPEC-SERVER-INSTALL I4).

use crate::layout::Layout;
use std::ffi::OsString;
use std::process::Command;

/// The bundled Node on `app/server.js`, in `app/` (migrations are found
/// relative to it), reading `server.env`. DATABASE_PATH and RELEASES_PATH
/// come from the folders; set in the environment, they win over the file.
/// BODY_SIZE_LIMIT is adapter-node's request size limit (512 KB by default):
/// Files uploads come in 8 MB pieces (SPEC-FILES F6), so it is 16 MB, as in
/// the container image.
pub fn command(layout: &Layout) -> Command {
    let mut env_file = OsString::from("--env-file=");
    env_file.push(layout.env_file());
    let mut command = Command::new(layout.node());
    command
        .arg(env_file)
        .arg(layout.entry())
        .current_dir(layout.app())
        .env("NODE_ENV", "production")
        .env("DATABASE_PATH", layout.database())
        .env("RELEASES_PATH", layout.releases())
        .env("BODY_SIZE_LIMIT", "16M");
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;
    use std::path::{Path, PathBuf};

    #[test]
    fn runs_the_bundled_node_on_the_server_with_the_folders_set() {
        let layout = Layout {
            program: PathBuf::from("/opt/bmuster-server"),
            data: PathBuf::from("/var/lib/bmuster-server"),
        };
        let command = command(&layout);
        assert_eq!(command.get_program(), layout.node().as_os_str());
        let arguments: Vec<&OsStr> = command.get_args().collect();
        let mut env_file = OsString::from("--env-file=");
        env_file.push(Path::new("/var/lib/bmuster-server").join("server.env"));
        assert_eq!(
            arguments,
            [env_file.as_os_str(), layout.entry().as_os_str()]
        );
        assert_eq!(command.get_current_dir(), Some(layout.app().as_path()));
        let envs: Vec<(&OsStr, Option<&OsStr>)> = command.get_envs().collect();
        assert!(envs.contains(&(
            OsStr::new("DATABASE_PATH"),
            Some(layout.database().as_os_str())
        )));
        assert!(envs.contains(&(
            OsStr::new("RELEASES_PATH"),
            Some(layout.releases().as_os_str())
        )));
        assert!(envs.contains(&(OsStr::new("NODE_ENV"), Some(OsStr::new("production")))));
        assert!(envs.contains(&(OsStr::new("BODY_SIZE_LIMIT"), Some(OsStr::new("16M")))));
    }
}
