//! Bounded private helper protocol. No remote credentials cross this pipe.
//! The Wayland portal helper and the KMS console helper share the framing:
//! a tag byte, a little-endian `u32` length, then the body.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

pub const MAX_PACKET: usize = 32 * 1024 * 1024;
/// Raw pixels (the console helper's BGRX frames): an 8K screen with room.
pub const MAX_RAW: usize = 256 * 1024 * 1024;
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Command {
    Configure {
        control: bool,
        restore_token: Option<String>,
    },
    Pointer {
        x: i32,
        y: i32,
    },
    Button {
        code: i32,
        down: bool,
    },
    Scroll {
        dx: f64,
        dy: f64,
    },
    Key {
        code: i32,
        down: bool,
    },
    Character {
        character: char,
    },
    Stop,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Event {
    Token {
        token: Option<String>,
    },
    Ready {
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    },
    Failed {
        message: String,
    },
}

pub enum Packet {
    Json(Vec<u8>),
    Png(Vec<u8>),
    /// Uncompressed pixels whose shape the JSON before them gave.
    Raw(Vec<u8>),
}

fn limit(tag: u8) -> usize {
    if tag == 3 {
        MAX_RAW
    } else {
        MAX_PACKET
    }
}

pub fn write(mut output: impl Write, packet: &Packet) -> Result<()> {
    let (tag, bytes) = match packet {
        Packet::Json(bytes) => (1, bytes),
        Packet::Png(bytes) => (2, bytes),
        Packet::Raw(bytes) => (3, bytes),
    };
    if bytes.is_empty() || bytes.len() > limit(tag) {
        bail!("Helper packet exceeds its size limit");
    }
    output.write_all(&[tag])?;
    output.write_all(&(bytes.len() as u32).to_le_bytes())?;
    output.write_all(bytes)?;
    output.flush()?;
    Ok(())
}
pub fn json(output: impl Write, value: &impl Serialize) -> Result<()> {
    write(output, &Packet::Json(serde_json::to_vec(value)?))
}
pub fn read(mut input: impl Read) -> Result<Packet> {
    let mut header = [0; 5];
    input.read_exact(&mut header)?;
    let size = u32::from_le_bytes(header[1..].try_into()?) as usize;
    if size == 0 || !matches!(header[0], 1..=3) || size > limit(header[0]) {
        bail!("Invalid helper packet header");
    }
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes)?;
    Ok(match header[0] {
        1 => Packet::Json(bytes),
        2 => Packet::Png(bytes),
        _ => Packet::Raw(bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validate_and_bound_frames() {
        for header in [
            [2, 255, 255, 255, 127],
            [4, 1, 0, 0, 0],
            [3, 0, 0, 0, 0x20],
            [2, 0, 0, 0, 0],
            [2, 1, 0, 0, 0],
        ] {
            assert!(read(header.as_slice()).is_err());
        }
        let mut bytes = Vec::new();
        json(
            &mut bytes,
            &Command::Configure {
                control: false,
                restore_token: None,
            },
        )
        .unwrap();
        let Packet::Json(body) = read(bytes.as_slice()).unwrap() else {
            panic!("JSON");
        };
        assert!(matches!(
            serde_json::from_slice::<Command>(&body).unwrap(),
            Command::Configure { control: false, .. }
        ));
    }
}
