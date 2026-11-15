//! A helper's half of a session over a byte stream (its stdin and stdout,
//! or a connect-back socket): each message is a frame of one byte for the
//! kind (0 text, 1 binary), the payload's length as four bytes big-endian,
//! then the payload. The files helper (SPEC-SESSION-UNITS) and the user
//! files helper (SPEC-SESSION-FILES) both speak it.

use super::pump::{Incoming, Outgoing};
use std::io::{self, Read, Write};

pub const TEXT: u8 = 0;
pub const BINARY: u8 = 1;
/// The largest frame either side accepts: a chunk is at most 8 MB and a
/// listing at most 5,000 entries, so anything bigger is a broken stream.
const MAX_FRAME: usize = 64 * 1024 * 1024;

pub fn write_frame(output: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    let length = u32::try_from(payload.len())
        .ok()
        .filter(|&length| length as usize <= MAX_FRAME)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;
    output.write_all(&[kind])?;
    output.write_all(&length.to_be_bytes())?;
    output.write_all(payload)?;
    output.flush()
}

pub fn write_message(output: &mut impl Write, message: &Outgoing) -> io::Result<()> {
    match message {
        Outgoing::Text(text) => write_frame(output, TEXT, text.as_bytes()),
        Outgoing::Bytes(bytes) => write_frame(output, BINARY, bytes),
        Outgoing::Done(event) => write_frame(output, TEXT, &serde_json::to_vec(event)?),
    }
}

/// The next frame, or `None` when the stream ended between frames.
pub fn read_frame(input: &mut impl Read) -> io::Result<Option<Incoming>> {
    let mut kind = [0u8; 1];
    match input.read_exact(&mut kind) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let mut length = [0u8; 4];
    input.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("a frame of {length} bytes is too large"),
        ));
    }
    let mut payload = vec![0u8; length];
    input.read_exact(&mut payload)?;
    match kind[0] {
        TEXT => String::from_utf8(payload)
            .map(|text| Some(Incoming::Text(text)))
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
        BINARY => Ok(Some(Incoming::Bytes(payload))),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("unknown frame kind {other}"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_keep_their_kind_and_bytes() {
        let mut wire = Vec::new();
        write_message(&mut wire, &Outgoing::Text("{\"id\":1}".into())).unwrap();
        write_message(&mut wire, &Outgoing::Bytes(vec![0, 1, 2, 255])).unwrap();
        assert_eq!(&wire[..5], &[TEXT, 0, 0, 0, 8]);
        let mut reader = wire.as_slice();
        assert!(matches!(
            read_frame(&mut reader).unwrap(),
            Some(Incoming::Text(text)) if text == "{\"id\":1}"
        ));
        assert!(matches!(
            read_frame(&mut reader).unwrap(),
            Some(Incoming::Bytes(bytes)) if bytes == [0, 1, 2, 255]
        ));
        assert!(read_frame(&mut reader).unwrap().is_none());
    }

    #[test]
    fn broken_frames_are_errors() {
        let oversized = [BINARY, 0xff, 0xff, 0xff, 0xff];
        assert!(read_frame(&mut oversized.as_slice()).is_err());
        let unknown = [7, 0, 0, 0, 0];
        assert!(read_frame(&mut unknown.as_slice()).is_err());
        let cut_short = [TEXT, 0, 0, 0, 9, b'x'];
        assert!(read_frame(&mut cut_short.as_slice()).is_err());
    }
}
