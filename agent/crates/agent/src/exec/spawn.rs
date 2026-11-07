//! Which program a session starts, with which arguments, environment and
//! working folder. Shared by the terminal and the exec runner.

use anyhow::{bail, Result};
use bmuster_protocol::session::Shell;
use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// A program to start and the arguments after its name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Program {
    pub path: PathBuf,
    /// Unix: the name the program sees as `argv[0]`; a leading `-` makes a
    /// login shell. Windows ignores it.
    pub arg0: OsString,
    pub args: Vec<OsString>,
}

/// Where and with what environment a session's processes run.
#[derive(Debug, Clone)]
pub struct Launch {
    pub program: Program,
    pub env: Vec<(OsString, OsString)>,
    pub cwd: PathBuf,
}

#[cfg(unix)]
fn first_existing(candidates: &[&str]) -> Option<PathBuf> {
    candidates
        .iter()
        .map(Path::new)
        .find(|path| path.is_file())
        .map(Path::to_path_buf)
}

#[cfg(unix)]
fn unix_shell(shell: Shell) -> Result<PathBuf> {
    let candidates: &[&str] = match shell {
        Shell::Bash => &[
            "/bin/bash",
            "/usr/bin/bash",
            "/usr/local/bin/bash",
            "/opt/homebrew/bin/bash",
        ],
        Shell::Sh => &["/bin/sh", "/usr/bin/sh"],
        Shell::Zsh => &["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"],
        Shell::Powershell | Shell::Cmd => {
            bail!("{} is a Windows shell", shell.as_str())
        }
    };
    match first_existing(candidates) {
        Some(path) => Ok(path),
        None => bail!("{} is not installed on this machine", shell.as_str()),
    }
}

#[cfg(windows)]
fn windows_shell(shell: Shell) -> Result<PathBuf> {
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from(r"C:\Windows"));
    let path = match shell {
        Shell::Powershell => {
            Path::new(&root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe")
        }
        Shell::Cmd => Path::new(&root).join(r"System32\cmd.exe"),
        Shell::Bash | Shell::Sh | Shell::Zsh => bail!("{} is not a Windows shell", shell.as_str()),
    };
    if !path.is_file() {
        bail!("{} is missing from this machine", path.display());
    }
    Ok(path)
}

/// An interactive shell for a terminal: a login shell on Unix.
pub fn interactive(shell: Shell) -> Result<Program> {
    #[cfg(unix)]
    {
        let path = unix_shell(shell)?;
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| shell.as_str().to_string());
        Ok(Program {
            path,
            arg0: OsString::from(format!("-{name}")),
            args: Vec::new(),
        })
    }
    #[cfg(windows)]
    {
        let path = windows_shell(shell)?;
        let args = match shell {
            Shell::Powershell => vec![OsString::from("-NoLogo")],
            _ => Vec::new(),
        };
        Ok(Program {
            arg0: path.clone().into_os_string(),
            path,
            args,
        })
    }
}

/// One command, run without a terminal and without input.
pub fn command_line(shell: Shell, command: &str) -> Result<Program> {
    #[cfg(unix)]
    {
        let path = unix_shell(shell)?;
        let flag = if shell == Shell::Sh { "-c" } else { "-lc" };
        Ok(Program {
            arg0: path.clone().into_os_string(),
            path,
            args: vec![OsString::from(flag), OsString::from(command)],
        })
    }
    #[cfg(windows)]
    {
        let path = windows_shell(shell)?;
        let args = match shell {
            Shell::Powershell => vec![
                OsString::from("-NoLogo"),
                OsString::from("-NoProfile"),
                OsString::from("-NonInteractive"),
                OsString::from("-Command"),
                OsString::from(command),
            ],
            _ => vec![
                OsString::from("/d"),
                OsString::from("/c"),
                OsString::from(command),
            ],
        };
        Ok(Program {
            arg0: path.clone().into_os_string(),
            path,
            args,
        })
    }
}

/// The account the agent runs as (root or SYSTEM in a service; the
/// developer in a development run): its name, home folder and shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Account {
    pub name: String,
    pub home: PathBuf,
}

#[cfg(unix)]
pub fn agent_account() -> Account {
    use std::ffi::CStr;
    let uid = unsafe { libc::geteuid() };
    let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
    let mut found: *mut libc::passwd = std::ptr::null_mut();
    let mut buffer = vec![0 as libc::c_char; 16 * 1024];
    // SAFETY: every pointer is valid for the call; `buffer` outlives the use
    // of the strings `entry` points into.
    let status = unsafe {
        libc::getpwuid_r(
            uid,
            &mut entry,
            buffer.as_mut_ptr(),
            buffer.len(),
            &mut found,
        )
    };
    if status != 0 || found.is_null() {
        let name = if uid == 0 { "root" } else { "unknown" };
        return Account {
            name: name.into(),
            home: PathBuf::from("/"),
        };
    }
    // SAFETY: getpwuid_r succeeded, so both are NUL-terminated strings in `buffer`.
    let (name, home) = unsafe {
        (
            CStr::from_ptr(entry.pw_name).to_string_lossy().into_owned(),
            CStr::from_ptr(entry.pw_dir).to_string_lossy().into_owned(),
        )
    };
    Account {
        name,
        home: PathBuf::from(home),
    }
}

/// On Windows `home` is where sessions start: the system drive's root
/// (`C:\`), not SYSTEM's profile under `C:\WINDOWS\system32\config`.
#[cfg(windows)]
pub fn agent_account() -> Account {
    let name = std::env::var("USERNAME").unwrap_or_else(|_| "SYSTEM".into());
    let home = system_drive_root(std::env::var("SystemDrive").ok().as_deref());
    Account { name, home }
}

/// `C:\` from `%SystemDrive%` (`C:`); `C:\` when it is missing or odd.
#[cfg(any(windows, test))]
fn system_drive_root(system_drive: Option<&str>) -> PathBuf {
    match system_drive {
        Some(drive)
            if drive.len() == 2
                && drive.as_bytes()[0].is_ascii_alphabetic()
                && drive.ends_with(':') =>
        {
            PathBuf::from(format!("{drive}\\"))
        }
        _ => PathBuf::from(r"C:\"),
    }
}

/// The search path for session processes on Unix: the agent's own may be a
/// service manager's minimal one.
#[cfg(unix)]
pub const UNIX_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// The environment for a session, as the agent's account, for console user
/// `console_user`. On Unix it starts clean (a service's environment is not a
/// login's); on Windows it is the agent's own, which holds what Windows
/// programs need (`SystemRoot`, `ComSpec`, …).
pub fn environment(
    account: &Account,
    program: &Program,
    console_user: &str,
    terminal: bool,
) -> Vec<(OsString, OsString)> {
    let mut env: Vec<(OsString, OsString)> = Vec::new();
    #[cfg(unix)]
    {
        let lang = std::env::var_os("LANG")
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| OsString::from("C.UTF-8"));
        env.push(("HOME".into(), account.home.clone().into_os_string()));
        env.push(("USER".into(), account.name.clone().into()));
        env.push(("LOGNAME".into(), account.name.clone().into()));
        env.push(("SHELL".into(), program.path.clone().into_os_string()));
        env.push(("PATH".into(), UNIX_PATH.into()));
        env.push(("LANG".into(), lang));
        if terminal {
            env.push(("TERM".into(), "xterm-256color".into()));
            env.push(("COLORTERM".into(), "truecolor".into()));
        }
    }
    #[cfg(windows)]
    {
        let _ = (account, program, terminal);
        env.extend(
            std::env::vars_os().filter(|(name, _)| !name.eq_ignore_ascii_case("BMUSTER_USER")),
        );
    }
    env.push(("BMUSTER_USER".into(), console_user.into()));
    env
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn unix_shells_resolve_to_login_shells() {
        let sh = interactive(Shell::Sh).unwrap();
        assert!(sh.path.is_file());
        assert!(sh.arg0.to_string_lossy().starts_with('-'));
        assert!(interactive(Shell::Powershell).is_err());
        let one = command_line(Shell::Sh, "echo hi").unwrap();
        assert_eq!(one.args, [OsString::from("-c"), OsString::from("echo hi")]);
    }

    #[test]
    fn the_environment_starts_clean_and_names_the_console_user() {
        let account = agent_account();
        assert!(!account.name.is_empty());
        let program = interactive(Shell::Sh).unwrap();
        let env = environment(&account, &program, "Jack", true);
        let get = |name: &str| {
            env.iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.to_string_lossy().into_owned())
        };
        assert_eq!(get("BMUSTER_USER").as_deref(), Some("Jack"));
        assert_eq!(get("TERM").as_deref(), Some("xterm-256color"));
        assert_eq!(get("PATH").as_deref(), Some(UNIX_PATH));
        assert_eq!(
            get("CARGO"),
            None,
            "nothing leaks from the agent's environment"
        );
    }
}

#[cfg(test)]
mod start_folder_tests {
    use super::system_drive_root;
    use std::path::PathBuf;

    #[test]
    fn windows_sessions_start_at_the_system_drive_root() {
        assert_eq!(system_drive_root(Some("C:")), PathBuf::from("C:\\"));
        assert_eq!(system_drive_root(Some("D:")), PathBuf::from("D:\\"));
        assert_eq!(system_drive_root(None), PathBuf::from("C:\\"));
        assert_eq!(system_drive_root(Some("weird")), PathBuf::from("C:\\"));
    }
}
