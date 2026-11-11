//! Waiting for a non-blocking session socket to be ready, so the pump can
//! sleep until the browser sends something (or the socket can take more
//! output) instead of polling: `poll` on Unix, `WSAPoll` on Windows.

use std::io;
use std::net::TcpStream;
use std::time::Duration;

/// Waits until `tcp` is readable (or writable, when `write` is set), it
/// fails or hangs up, or `limit` passes. Which of those happened does not
/// matter: the caller tries again either way.
pub fn wait(tcp: &TcpStream, write: bool, limit: Duration) -> io::Result<()> {
    let millis = i32::try_from(limit.as_millis()).unwrap_or(i32::MAX);
    match platform::poll(tcp, write, millis) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::Interrupted => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(unix)]
mod platform {
    use std::io;
    use std::net::TcpStream;
    use std::os::fd::AsRawFd as _;

    pub fn poll(tcp: &TcpStream, write: bool, millis: i32) -> io::Result<()> {
        let mut events = libc::POLLIN;
        if write {
            events |= libc::POLLOUT;
        }
        let mut fd = libc::pollfd {
            fd: tcp.as_raw_fd(),
            events,
            revents: 0,
        };
        // SAFETY: one valid pollfd for a socket this borrow keeps open.
        if unsafe { libc::poll(&mut fd, 1, millis) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use std::io;
    use std::net::TcpStream;
    use std::os::windows::io::AsRawSocket as _;
    use windows_sys::Win32::Networking::WinSock::{
        WSAGetLastError, WSAPoll, POLLRDNORM, POLLWRNORM, SOCKET, SOCKET_ERROR, WSAPOLLFD,
    };

    pub fn poll(tcp: &TcpStream, write: bool, millis: i32) -> io::Result<()> {
        let mut events = POLLRDNORM;
        if write {
            events |= POLLWRNORM;
        }
        let mut fd = WSAPOLLFD {
            fd: tcp.as_raw_socket() as SOCKET,
            events,
            revents: 0,
        };
        // SAFETY: one valid WSAPOLLFD for a socket this borrow keeps open.
        if unsafe { WSAPoll(&mut fd, 1, millis) } == SOCKET_ERROR {
            // SAFETY: reads this thread's last Winsock error.
            return Err(io::Error::from_raw_os_error(unsafe { WSAGetLastError() }));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::net::TcpListener;
    use std::time::Instant;

    #[test]
    fn wait_returns_at_once_when_data_arrives_and_after_the_limit_when_none_does() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut sender = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (receiver, _) = listener.accept().unwrap();
        receiver.set_nonblocking(true).unwrap();

        let started = Instant::now();
        wait(&receiver, false, Duration::from_millis(200)).unwrap();
        assert!(
            started.elapsed() >= Duration::from_millis(150),
            "nothing to read: waits"
        );

        sender.write_all(b"x").unwrap();
        let started = Instant::now();
        wait(&receiver, false, Duration::from_secs(5)).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "data: returns at once"
        );

        let started = Instant::now();
        wait(&receiver, true, Duration::from_secs(5)).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "writable: returns at once"
        );
    }
}
