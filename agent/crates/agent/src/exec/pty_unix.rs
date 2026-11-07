//! Pseudo-terminals on Linux and macOS: `openpty`, then the shell as the
//! leader of a new session with the terminal as its controlling terminal.
//!
//! The child set-up (signal reset, `setsid`, `TIOCSCTTY`) follows
//! portable-pty's `src/unix.rs` (MIT, Copyright (c) 2018 Wez Furlong),
//! rewritten on `libc` and `std::process::Command`.

use super::spawn::Launch;
use super::tree;
use super::PtySize;
use anyhow::{bail, Context as _, Result};
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd};
use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::process::{Child, Command, Stdio};

/// The terminal's controlling side. Shared by the session's threads.
pub struct Pty {
    master: OwnedFd,
    /// The shell's pid, which is also its session id.
    pid: libc::pid_t,
}

/// A started shell: the terminal, the process to wait for, and the two
/// directions of the terminal's byte stream.
pub struct Spawned {
    pub pty: Pty,
    pub process: ShellProcess,
    pub reader: File,
    pub writer: File,
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
    pub fn spawn(launch: &Launch, size: PtySize) -> Result<Spawned> {
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
        let (master, slave) =
            unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        // Neither end may leak into the shell or into other sessions' shells.
        set_cloexec(master.as_raw_fd())?;
        set_cloexec(slave.as_raw_fd())?;
        resize(&master, size)?;

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
        let child = command
            .spawn()
            .with_context(|| format!("could not start {}", launch.program.path.display()))?;
        let pid = libc::pid_t::try_from(child.id()).context("process id out of range")?;
        let reader = File::from(master.try_clone()?);
        let writer = File::from(master.try_clone()?);
        Ok(Spawned {
            pty: Pty { master, pid },
            process: ShellProcess(child),
            reader,
            writer,
        })
    }

    pub fn resize(&self, size: PtySize) -> Result<()> {
        resize(&self.master, size)
    }

    /// Ends the shell and everything it started.
    pub fn end(&self) {
        tree::end_session(self.pid);
    }
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
pub struct ShellProcess(Child);

impl ShellProcess {
    /// Waits for the shell to end: its exit code, or 128 + the signal that
    /// ended it (as shells report).
    pub fn wait(&mut self) -> Result<i32> {
        let status = self.0.wait().context("could not wait for the shell")?;
        Ok(status
            .code()
            .or_else(|| status.signal().map(|signal| 128 + signal))
            .unwrap_or(-1))
    }
}

/// True when a read from the terminal means "the other side is gone".
/// Linux answers EIO once every holder of the terminal has closed it.
pub fn is_hangup(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc::EIO)
}
