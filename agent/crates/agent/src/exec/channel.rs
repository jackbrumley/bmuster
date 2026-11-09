//! The framing between the agent and a unit's host program (`pty-host`,
//! `stdio-host`) over the connect-back socket (SPEC-SESSION-UNITS,
//! Version 2). Each frame is one byte naming the channel, the payload's
//! length as four bytes big-endian, then the payload: the same shape as the
//! files helper's frames, with channels instead of message kinds.

use super::PtySize;
use std::io::{self, Read, Write};

const INPUT: u8 = 0;
const STDOUT: u8 = 1;
const STDERR: u8 = 2;
const EXIT: u8 = 3;
const INPUT_CLOSED: u8 = 4;
const RESIZE: u8 = 5;
const FAILED: u8 = 6;

/// The largest payload either side sends or accepts; longer byte runs are
/// split into several frames.
pub const MAX_PAYLOAD: usize = 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    /// Agent → host: bytes for the program's input (the terminal's keys).
    Input(Vec<u8>),
    /// Agent → host: the program's input ends.
    InputClosed,
    /// Agent → host: the terminal's new size (also the first frame a
    /// terminal host waits for).
    Resize(PtySize),
    /// Host → agent: the program's output (the terminal's screen bytes).
    Stdout(Vec<u8>),
    /// Host → agent: the program's error output.
    Stderr(Vec<u8>),
    /// Host → agent: the program ended with this code (128 + the signal).
    Exit(i32),
    /// Host → agent: the program could not be started, and why.
    Failed(String),
}

fn header(output: &mut impl Write, kind: u8, length: usize) -> io::Result<()> {
    let length = u32::try_from(length)
        .ok()
        .filter(|&length| length as usize <= MAX_PAYLOAD)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;
    output.write_all(&[kind])?;
    output.write_all(&length.to_be_bytes())
}

/// Writes one frame and flushes.
pub fn write(output: &mut impl Write, frame: &Frame) -> io::Result<()> {
    let (kind, payload): (u8, Vec<u8>) = match frame {
        Frame::Input(bytes) => (INPUT, bytes.clone()),
        Frame::InputClosed => (INPUT_CLOSED, Vec::new()),
        Frame::Resize(size) => {
            let mut payload = size.cols.to_be_bytes().to_vec();
            payload.extend_from_slice(&size.rows.to_be_bytes());
            (RESIZE, payload)
        }
        Frame::Stdout(bytes) => (STDOUT, bytes.clone()),
        Frame::Stderr(bytes) => (STDERR, bytes.clone()),
        Frame::Exit(code) => (EXIT, code.to_be_bytes().to_vec()),
        Frame::Failed(message) => (FAILED, message.as_bytes().to_vec()),
    };
    header(output, kind, payload.len())?;
    output.write_all(&payload)?;
    output.flush()
}

/// Writes `bytes` as as many frames of `make` as it takes.
pub fn write_split(
    output: &mut impl Write,
    bytes: &[u8],
    make: fn(Vec<u8>) -> Frame,
) -> io::Result<()> {
    for chunk in bytes.chunks(MAX_PAYLOAD) {
        write(output, &make(chunk.to_vec()))?;
    }
    Ok(())
}

fn invalid(message: String) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// The next frame, or `None` when the stream ended between frames.
pub fn read(input: &mut impl Read) -> io::Result<Option<Frame>> {
    let mut kind = [0u8; 1];
    match input.read_exact(&mut kind) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let mut length = [0u8; 4];
    input.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_PAYLOAD {
        return Err(invalid(format!("a frame of {length} bytes is too large")));
    }
    let mut payload = vec![0u8; length];
    input.read_exact(&mut payload)?;
    let fixed = |payload: &[u8], size: usize| -> io::Result<()> {
        if payload.len() == size {
            Ok(())
        } else {
            Err(invalid(format!(
                "frame kind {} needs {size} bytes, not {}",
                kind[0],
                payload.len()
            )))
        }
    };
    let frame = match kind[0] {
        INPUT => Frame::Input(payload),
        INPUT_CLOSED => {
            fixed(&payload, 0)?;
            Frame::InputClosed
        }
        RESIZE => {
            fixed(&payload, 4)?;
            Frame::Resize(PtySize::clamped(
                u16::from_be_bytes([payload[0], payload[1]]),
                u16::from_be_bytes([payload[2], payload[3]]),
            ))
        }
        STDOUT => Frame::Stdout(payload),
        STDERR => Frame::Stderr(payload),
        EXIT => {
            fixed(&payload, 4)?;
            Frame::Exit(i32::from_be_bytes([
                payload[0], payload[1], payload[2], payload[3],
            ]))
        }
        FAILED => Frame::Failed(String::from_utf8_lossy(&payload).into_owned()),
        other => return Err(invalid(format!("unknown frame kind {other}"))),
    };
    Ok(Some(frame))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_frame_survives_the_wire() {
        let frames = [
            Frame::Input(b"ls\n".to_vec()),
            Frame::InputClosed,
            Frame::Resize(PtySize {
                cols: 132,
                rows: 43,
            }),
            Frame::Stdout(vec![0, 255]),
            Frame::Stderr(b"oops".to_vec()),
            Frame::Exit(-1),
            Frame::Failed("no such program".into()),
        ];
        let mut wire = Vec::new();
        for frame in &frames {
            write(&mut wire, frame).unwrap();
        }
        let mut reader = wire.as_slice();
        for frame in &frames {
            assert_eq!(read(&mut reader).unwrap().as_ref(), Some(frame));
        }
        assert_eq!(read(&mut reader).unwrap(), None);
    }

    #[test]
    fn long_runs_are_split_and_broken_frames_refused() {
        let mut wire = Vec::new();
        write_split(&mut wire, &vec![7; MAX_PAYLOAD + 1], Frame::Stdout).unwrap();
        let mut reader = wire.as_slice();
        assert!(
            matches!(read(&mut reader).unwrap(), Some(Frame::Stdout(b)) if b.len() == MAX_PAYLOAD)
        );
        assert!(matches!(read(&mut reader).unwrap(), Some(Frame::Stdout(b)) if b.len() == 1));
        assert!(read(&mut [9u8, 0, 0, 0, 0].as_slice()).is_err());
        assert!(read(&mut [EXIT, 0, 0, 0, 1, 0].as_slice()).is_err());
        assert!(read(&mut [STDOUT, 0xff, 0xff, 0xff, 0xff].as_slice()).is_err());
    }
}
