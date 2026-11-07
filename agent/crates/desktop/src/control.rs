//! Control messages (SPEC-DESKTOP 5) and the permission filter (section 7).
//!
//! Text frames, JSON, one object with a `type` per frame. Unknown types are
//! reported as [`Parsed::Unknown`] so the session can ignore them (logged
//! once); a known type with bad fields is [`Parsed::Bad`].

use crate::capture::{DesktopState, DisplayInfo};
use crate::pacing::Quality;
use serde::{Deserialize, Serialize};

/// Longest `text` message, in characters.
pub const MAX_TEXT_CHARS: usize = 256;
/// Longest `clipboard-push`, in bytes.
pub const MAX_CLIPBOARD_BYTES: usize = 1024 * 1024;

pub const PERMISSION_VIEW: &str = "desktop-view";
pub const PERMISSION_CONTROL: &str = "desktop-control";

/// What the ticket lets this session do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Watch,
    Control,
}

impl Mode {
    /// Reads the ticket's permissions. A desktop ticket always carries
    /// `desktop-view`; `desktop-control` on top of it means control.
    pub fn from_permissions<S: AsRef<str>>(permissions: &[S]) -> Result<Mode, String> {
        let has = |name: &str| permissions.iter().any(|p| p.as_ref() == name);
        match (has(PERMISSION_VIEW), has(PERMISSION_CONTROL)) {
            (true, true) => Ok(Mode::Control),
            (true, false) => Ok(Mode::Watch),
            (false, _) => Err("the ticket does not grant desktop-view".to_string()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    H264,
    Jpeg,
    Webp,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewport {
    pub width: f64,
    pub height: f64,
    pub pixel_ratio: f64,
}

/// The `scale` setting: fit the viewer's viewport, or a fixed factor.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Scale {
    Fit,
    Factor(f64),
}

impl<'de> Deserialize<'de> for Scale {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Raw {
            Name(String),
            Number(f64),
        }
        match Raw::deserialize(deserializer)? {
            Raw::Name(name) if name == "fit" => Ok(Scale::Fit),
            Raw::Number(n) if [1.0, 0.75, 0.5, 0.25].contains(&n) => Ok(Scale::Factor(n)),
            _ => Err(serde::de::Error::custom(
                "scale must be 'fit', 1, 0.75, 0.5 or 0.25",
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WheelMode {
    Pixel,
    Line,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SpecialKey {
    CtrlAltDel,
    Win,
    AltTab,
    PrintScreen,
}

/// A message from the browser (SPEC-DESKTOP 5.1).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum ClientMessage {
    Hello {
        codecs: Vec<Codec>,
        viewport: Viewport,
    },
    Keyframe,
    Ack {
        seq: u32,
    },
    SelectDisplay {
        display: String,
    },
    Settings {
        quality: Quality,
        scale: Scale,
        max_fps: u32,
    },
    Pointer {
        x: f64,
        y: f64,
        buttons: u8,
    },
    Wheel {
        dx: f64,
        dy: f64,
        mode: WheelMode,
    },
    Key {
        code: String,
        key: String,
        down: bool,
        alt_gr: bool,
    },
    Text {
        text: String,
    },
    Special {
        name: SpecialKey,
    },
    ReleaseAll,
    ClipboardPush {
        text: String,
    },
    ClipboardPull,
    Disconnect,
}

const KNOWN_TYPES: [&str; 14] = [
    "hello",
    "keyframe",
    "ack",
    "select-display",
    "settings",
    "pointer",
    "wheel",
    "key",
    "text",
    "special",
    "release-all",
    "clipboard-push",
    "clipboard-pull",
    "disconnect",
];

impl ClientMessage {
    /// Messages a watch-only session drops (SPEC-DESKTOP 7).
    pub fn needs_control(&self) -> bool {
        matches!(
            self,
            ClientMessage::Pointer { .. }
                | ClientMessage::Wheel { .. }
                | ClientMessage::Key { .. }
                | ClientMessage::Text { .. }
                | ClientMessage::Special { .. }
                | ClientMessage::ReleaseAll
                | ClientMessage::ClipboardPush { .. }
                | ClientMessage::ClipboardPull
        )
    }

    fn validate(self) -> Result<Self, String> {
        match &self {
            ClientMessage::Text { text } if text.chars().count() > MAX_TEXT_CHARS => {
                Err(format!("text is over {MAX_TEXT_CHARS} characters"))
            }
            ClientMessage::ClipboardPush { text } if text.len() > MAX_CLIPBOARD_BYTES => {
                Err("clipboard text is over 1 MB".to_string())
            }
            ClientMessage::Settings { max_fps, .. } if ![5, 10, 15, 30].contains(max_fps) => {
                Err("maxFps must be 5, 10, 15 or 30".to_string())
            }
            ClientMessage::Pointer { x, y, .. } if !x.is_finite() || !y.is_finite() => {
                Err("pointer position must be a number".to_string())
            }
            ClientMessage::Wheel { dx, dy, .. } if !dx.is_finite() || !dy.is_finite() => {
                Err("wheel delta must be a number".to_string())
            }
            _ => Ok(self),
        }
    }
}

/// The result of reading one text frame.
#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    Message(ClientMessage),
    /// A type this agent does not know (a newer browser); ignored.
    Unknown(String),
    /// Malformed JSON, or a known type with bad fields.
    Bad(String),
}

pub fn parse(text: &str) -> Parsed {
    match serde_json::from_str::<ClientMessage>(text) {
        Ok(message) => match message.validate() {
            Ok(message) => Parsed::Message(message),
            Err(reason) => Parsed::Bad(reason),
        },
        Err(error) => {
            let kind = serde_json::from_str::<serde_json::Value>(text)
                .ok()
                .and_then(|value| value.get("type")?.as_str().map(str::to_string));
            match kind {
                Some(kind) if !KNOWN_TYPES.contains(&kind.as_str()) => Parsed::Unknown(kind),
                _ => Parsed::Bad(error.to_string()),
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorCode {
    NotAllowed,
    TooManySessions,
    CaptureFailed,
    EncoderFailed,
    BadMessage,
}

/// Why a session ended (SPEC-DESKTOP 9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EndReason {
    Closed,
    Declined,
    TimedOut,
    DisconnectedAtMachine,
    NoBrowser,
    AgentLost,
    PermissionRemoved,
    TooManySessions,
}

/// A message to the browser (SPEC-DESKTOP 5.2). Consent, Wayland and
/// clipboard replies come with their phases.
#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum AgentMessage {
    Displays {
        list: Vec<DisplayInfo>,
        current: String,
    },
    Stream {
        display: String,
        codec: Codec,
        width: u32,
        height: u32,
        scale: f64,
    },
    State(DesktopState),
    Stalled,
    Error {
        code: ErrorCode,
        message: String,
    },
    Ended {
        reason: EndReason,
    },
}

impl AgentMessage {
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|error| {
            // Serialising these plain structs cannot fail; say so loudly if it does.
            format!(r#"{{"type":"error","code":"bad-message","message":"{error}"}}"#)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::DesktopKind;

    #[test]
    fn permissions_watch_and_control_from_the_ticket() {
        assert_eq!(Mode::from_permissions(&["desktop-view"]), Ok(Mode::Watch));
        assert_eq!(
            Mode::from_permissions(&["desktop-view", "desktop-control"]),
            Ok(Mode::Control)
        );
        assert!(Mode::from_permissions(&["desktop-control"]).is_err());
        assert!(Mode::from_permissions::<&str>(&[]).is_err());
    }

    #[test]
    fn permissions_control_messages_are_marked() {
        for text in [
            r#"{"type":"pointer","x":1,"y":2,"buttons":1}"#,
            r#"{"type":"wheel","dx":0,"dy":120,"mode":"pixel"}"#,
            r#"{"type":"key","code":"KeyA","key":"a","down":true,"altGr":false}"#,
            r#"{"type":"text","text":"hi"}"#,
            r#"{"type":"special","name":"ctrl-alt-del"}"#,
            r#"{"type":"release-all"}"#,
            r#"{"type":"clipboard-push","text":"x"}"#,
            r#"{"type":"clipboard-pull"}"#,
        ] {
            let Parsed::Message(message) = parse(text) else {
                panic!("{text} did not parse");
            };
            assert!(message.needs_control(), "{text}");
        }
        for text in [
            r#"{"type":"hello","codecs":["jpeg"],"viewport":{"width":800,"height":600,"pixelRatio":2}}"#,
            r#"{"type":"keyframe"}"#,
            r#"{"type":"ack","seq":4}"#,
            r#"{"type":"select-display","display":"DP-1"}"#,
            r#"{"type":"settings","quality":"auto","scale":"fit","maxFps":15}"#,
            r#"{"type":"disconnect"}"#,
        ] {
            let Parsed::Message(message) = parse(text) else {
                panic!("{text} did not parse");
            };
            assert!(!message.needs_control(), "{text}");
        }
    }

    #[test]
    fn control_parse_fields_and_limits() {
        assert_eq!(
            parse(r#"{"type":"settings","quality":"high","scale":0.5,"maxFps":30}"#),
            Parsed::Message(ClientMessage::Settings {
                quality: Quality::High,
                scale: Scale::Factor(0.5),
                max_fps: 30
            })
        );
        assert!(matches!(
            parse(r#"{"type":"settings","quality":"high","scale":0.6,"maxFps":30}"#),
            Parsed::Bad(_)
        ));
        assert!(matches!(
            parse(r#"{"type":"settings","quality":"high","scale":1,"maxFps":20}"#),
            Parsed::Bad(_)
        ));
        let long = "x".repeat(MAX_TEXT_CHARS + 1);
        assert!(matches!(
            parse(&format!(r#"{{"type":"text","text":"{long}"}}"#)),
            Parsed::Bad(_)
        ));
        assert!(matches!(parse("not json"), Parsed::Bad(_)));
        assert!(matches!(parse(r#"{"type":"ack"}"#), Parsed::Bad(_)));
        assert_eq!(
            parse(r#"{"type":"future-thing","x":1}"#),
            Parsed::Unknown("future-thing".to_string())
        );
    }

    #[test]
    fn control_agent_messages_serialise_as_the_spec_says() {
        let state = AgentMessage::State(DesktopState {
            desktop: DesktopKind::Greeter,
            locked: false,
            signed_in_user: None,
        });
        assert_eq!(
            state.to_json(),
            r#"{"type":"state","desktop":"greeter","locked":false,"signedInUser":null}"#
        );
        assert_eq!(
            AgentMessage::Error {
                code: ErrorCode::NotAllowed,
                message: "watch only".into()
            }
            .to_json(),
            r#"{"type":"error","code":"not-allowed","message":"watch only"}"#
        );
        assert_eq!(
            AgentMessage::Ended {
                reason: EndReason::DisconnectedAtMachine
            }
            .to_json(),
            r#"{"type":"ended","reason":"disconnected-at-machine"}"#
        );
        assert_eq!(AgentMessage::Stalled.to_json(), r#"{"type":"stalled"}"#);
    }
}
