//! Linux ioctl request numbers, worked out as `<asm-generic/ioctl.h>` does,
//! and one checked call. Shared by KMS capture and uinput.

use std::os::fd::{AsRawFd, BorrowedFd};

const NR_BITS: u64 = 8;
const TYPE_BITS: u64 = 8;
const SIZE_BITS: u64 = 14;
const TYPE_SHIFT: u64 = NR_BITS;
const SIZE_SHIFT: u64 = TYPE_SHIFT + TYPE_BITS;
const DIR_SHIFT: u64 = SIZE_SHIFT + SIZE_BITS;

const NONE: u64 = 0;
const WRITE: u64 = 1;
const READ: u64 = 2;

const fn ioc(dir: u64, kind: u8, nr: u8, size: usize) -> u64 {
    (dir << DIR_SHIFT) | ((size as u64) << SIZE_SHIFT) | ((kind as u64) << TYPE_SHIFT) | nr as u64
}

/// `_IO(kind, nr)`.
pub(crate) const fn io(kind: u8, nr: u8) -> u64 {
    ioc(NONE, kind, nr, 0)
}

/// `_IOW(kind, nr, T)`.
pub(crate) const fn iow<T>(kind: u8, nr: u8) -> u64 {
    ioc(WRITE, kind, nr, std::mem::size_of::<T>())
}

/// `_IOWR(kind, nr, T)`.
pub(crate) const fn iowr<T>(kind: u8, nr: u8) -> u64 {
    ioc(READ | WRITE, kind, nr, std::mem::size_of::<T>())
}

/// Calls `ioctl(fd, request, argument)`, retrying on EINTR.
///
/// # Safety
///
/// `argument` must be what `request` expects: a pointer to a live value of
/// the request's type (which the kernel may write), or a plain integer for
/// requests that take one.
pub(crate) unsafe fn call(
    fd: BorrowedFd<'_>,
    request: u64,
    argument: libc::c_ulong,
) -> std::io::Result<libc::c_int> {
    loop {
        // SAFETY: the caller promises `argument` matches `request`; `fd` is
        // a borrowed, open descriptor for the length of the call.
        let result = unsafe { libc::ioctl(fd.as_raw_fd(), request as _, argument) };
        if result >= 0 {
            return Ok(result);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() != std::io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

/// [`call`] with a pointer to `value`.
///
/// # Safety
///
/// `T` must be the type `request` reads and writes, and any pointers inside
/// `value` must point at buffers as large as the counts beside them say.
pub(crate) unsafe fn call_with<T>(
    fd: BorrowedFd<'_>,
    request: u64,
    value: &mut T,
) -> std::io::Result<libc::c_int> {
    // SAFETY: forwarded from the caller; `value` is a live, exclusive borrow.
    unsafe { call(fd, request, value as *mut T as libc::c_ulong) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_numbers_match_the_kernel_headers() {
        // Values printed by a C program from <linux/uinput.h> and <drm/drm.h>.
        assert_eq!(io(b'U', 1), 0x5501);
        assert_eq!(iow::<libc::c_int>(b'U', 100), 0x4004_5564);
        assert_eq!(iowr::<[u8; 64]>(b'd', 0xA0), 0xC040_64A0);
    }
}
