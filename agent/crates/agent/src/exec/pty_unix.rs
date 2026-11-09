//! Pseudo-terminals on Linux and macOS: `openpty`, then the shell as the
//! leader of a new session with the terminal as its controlling terminal.
//!
//! In a transient unit (Linux, SPEC-SESSION-UNITS Version 2) the pty is not
//! the agent's: the unit runs `pty-host`, which makes the pty inside the
//! unit with this same code and relays it over the connect-back socket.
//! Here that is the same `Spawned` the agent's own terminals give.
//!
//! The child set-up (signal reset, `setsid`, `TIOCSCTTY`) follows
//! portable-pty's `src/unix.rs` (MIT, Copyright (c) 2018 Wez Furlong),
//! rewritten on `libc` and `std::process::Command`.

use super::placement::Placement;
use super::spawn::Launch;
use super::tree;
use super::PtySize;
use anyhow::{bail, Context as _, Result};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd};
use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::process::{Child, Command, Stdio};

/// The terminal's controlling side. Shared by the session's threads.
pub struct Pty {
    side: Side,
    placement: Placement,
}

enum Side {
    /// The agent's own pty and the shell's pid, which is also its session id.
    Local { master: OwnedFd, pid: libc::pid_t },
    /// The unit's `pty-host`, over its connection.
    #[cfg(target_os = "linux")]
    Unit {
        input: super::host::HostInput,
        systemd_run: super::host::SystemdRun,
    },
}

/// A started shell: the terminal, the process to wait for, and the two
/// directions of the terminal's byte stream.
pub struct Spawned {
    pub pty: Pty,
    pub process: ShellProcess,
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
}

fn winsize(size: PtySize) -> libc::winsize {
    libc::winsize {
        ws_row: size.rows,
        ws_col: size.cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

fn set_cloexec(fd: libc::c_int) -> io::Result<()> {
    // SAFETY: fcntl on a descriptor we own.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

impl Pty {
    pub fn spawn(launch: &Launch, placement: Placement, size: PtySize) -> Result<Spawned> {
        match placement {
            Placement::InProcess => spawn_local(launch, size),
            #[cfg(target_os = "linux")]
            Placement::Unit(unit) => spawn_unit(launch, unit, size),
        }
    }

    pub fn resize(&self, size: PtySize) -> Result<()> {
        match &self.side {
            Side::Local { master, .. } => resize(master, size),
            #[cfg(target_os = "linux")]
            Side::Unit { input, .. } => input
                .resize(size)
                .context("could not resize the terminal: its host is gone"),
        }
    }

    /// Ends the shell and everything it started: its unit (and the
    /// connection to its host), or the shell's own session.
    pub fn end(&self) {
        self.placement.end();
        match &self.side {
            Side::Local { pid, .. } => tree::end_session(*pid),
            #[cfg(target_os = "linux")]
            Side::Unit { systemd_run, .. } => systemd_run.end(),
        }
    }
}

fn spawn_local(launch: &Launch, size: PtySize) -> Result<Spawned> {
    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    // SAFETY: openpty writes two descriptors; the name, settings and
    // size pointers may be null.
    let opened = unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if opened != 0 {
        return Err(io::Error::last_os_error()).context("could not open a pseudo-terminal");
    }
    // SAFETY: openpty succeeded, so both are open descriptors we now own.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    // Neither end may leak into the shell or into other sessions' shells.
    set_cloexec(master.as_raw_fd())?;
    set_cloexec(slave.as_raw_fd())?;
    resize(&master, size)?;

    let mut command = shell_on(launch, slave)?;
    let child = command.spawn().with_context(|| {
        format!(
            "could not start {}",
            std::path::Path::new(command.get_program()).display()
        )
    })?;
    let pid = libc::pid_t::try_from(child.id()).context("process id out of range")?;
    let reader = File::from(master.try_clone()?);
    let writer = File::from(master.try_clone()?);
    Ok(Spawned {
        pty: Pty {
            side: Side::Local { master, pid },
            placement: Placement::InProcess,
        },
        process: ShellProcess::Local(child),
        reader: Box::new(reader),
        writer: Box::new(writer),
    })
}

/// The shell in its own unit under `pty-host`, which makes the pty there.
/// Its first frame is the terminal's size.
#[cfg(target_os = "linux")]
fn spawn_unit(launch: &Launch, unit: super::unit::TransientUnit, size: PtySize) -> Result<Spawned> {
    use super::host::{self, HostProgram, InputWriter};
    let never = std::sync::atomic::AtomicBool::new(false);
    let started = host::start(&unit, HostProgram::Pty, launch, None, &never)?;
    let host::Started {
        channels,
        systemd_run,
    } = started;
    let pty = Pty {
        side: Side::Unit {
            input: channels.input.clone(),
            systemd_run,
        },
        placement: Placement::Unit(unit),
    };
    channels
        .input
        .resize(size)
        .context("could not reach the terminal's host")?;
    Ok(Spawned {
        pty,
        process: ShellProcess::Unit(channels.exit),
        reader: Box::new(channels.stdout),
        writer: Box::new(InputWriter::new(channels.input)),
    })
}

/// The shell as a child of this process: the leader of a new session with
/// the terminal as its controlling terminal.
fn shell_on(launch: &Launch, slave: OwnedFd) -> Result<Command> {
    let mut command = Command::new(&launch.program.path);
    command
        .arg0(&launch.program.arg0)
        .args(&launch.program.args)
        .env_clear()
        .envs(launch.env.iter().map(|(name, value)| (name, value)))
        .current_dir(&launch.cwd)
        .stdin(Stdio::from(slave.try_clone()?))
        .stdout(Stdio::from(slave.try_clone()?))
        .stderr(Stdio::from(slave));
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(|| {
            for signal in [
                libc::SIGCHLD,
                libc::SIGHUP,
                libc::SIGINT,
                libc::SIGQUIT,
                libc::SIGTERM,
                libc::SIGALRM,
                libc::SIGPIPE,
            ] {
                libc::signal(signal, libc::SIG_DFL);
            }
            let mut empty: libc::sigset_t = std::mem::zeroed();
            libc::sigemptyset(&mut empty);
            libc::sigprocmask(libc::SIG_SETMASK, &empty, std::ptr::null_mut());
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            // stdin is the terminal: make it the controlling terminal.
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    Ok(command)
}

impl Drop for Pty {
    fn drop(&mut self) {
        self.end();
    }
}

fn resize(master: &OwnedFd, size: PtySize) -> Result<()> {
    let size = winsize(size);
    // SAFETY: TIOCSWINSZ reads one winsize from the pointer.
    if unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ as _, &size) } != 0 {
        bail!(
            "could not resize the terminal: {}",
            io::Error::last_os_error()
        );
    }
    Ok(())
}

/// The shell process, for the thread that waits for it to end.
pub enum ShellProcess {
    Local(Child),
    /// The exit code the unit's `pty-host` reports.
    #[cfg(target_os = "linux")]
    Unit(super::host::Exit),
}

impl ShellProcess {
    /// Waits for the shell to end: its exit code, or 128 + the signal that
    /// ended it (as shells report).
    pub fn wait(&mut self) -> Result<i32> {
        match self {
            ShellProcess::Local(child) => {
                let status = child.wait().context("could not wait for the shell")?;
                Ok(status
                    .code()
                    .or_else(|| status.signal().map(|signal| 128 + signal))
                    .unwrap_or(-1))
            }
            #[cfg(target_os = "linux")]
            ShellProcess::Unit(exit) => exit
                .wait()
                .code()?
                .context("the terminal's host gave no exit code"),
        }
    }
}

/// True when a read from the terminal means "the other side is gone".
/// Linux answers EIO once every holder of the terminal has closed it.
pub fn is_hangup(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::EIO)
}
