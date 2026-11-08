//! Bounded private helper protocol. No remote credentials cross this pipe.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};

pub const MAX_PACKET: usize = 32 * 1024 * 1024;
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
}

pub fn write(mut output: impl Write, packet: &Packet) -> Result<()> {
    let (tag, bytes) = match packet {
        Packet::Json(bytes) => (1, bytes),
        Packet::Png(bytes) => (2, bytes),
    };
    if bytes.is_empty() || bytes.len() > MAX_PACKET {
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
    if size == 0 || size > MAX_PACKET || !matches!(header[0], 1 | 2) {
        bail!("Invalid helper packet header");
    }
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes)?;
    Ok(if header[0] == 1 {
        Packet::Json(bytes)
    } else {
        Packet::Png(bytes)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validate_and_bound_frames() {
        for header in [
            [2, 255, 255, 255, 127],
            [3, 1, 0, 0, 0],
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
