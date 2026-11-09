//! Stay awake on mains power (SPEC-STAY-AWAKE): the inventory's `power`
//! report. The server's setting travels on the live socket as
//! [`crate::ServerMessage::PowerPolicy`], a single boolean.

use serde::{Deserialize, Serialize};

/// What the machine runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PowerSource {
    /// On mains power, or a machine without a battery.
    Mains,
    Battery,
    /// The system would not say.
    Unknown,
}

/// What the agent does about sleep.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeepAwake {
    /// The setting is off: the machine sleeps as it is set to.
    Off,
    /// The setting is on and the machine is on mains power.
    Active,
    /// The setting is on, but the machine is on battery (or will not say).
    WaitingForMains,
}

/// The agent's sleep inhibitor.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Inhibitor {
    Held,
    None,
    /// The agent should hold one and could not take it.
    Failed {
        reason: String,
    },
}

/// The inventory's `power`. Agents before SPEC-STAY-AWAKE leave it out,
/// which reads as `unreported`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum PowerReport {
    #[default]
    Unreported,
    #[serde(rename_all = "camelCase")]
    Reported {
        source: PowerSource,
        /// Rounded to 5 so ordinary drain does not resend the inventory each
        /// check-in; `None` without a battery or when the system will not say.
        battery_percent: Option<u8>,
        keep_awake: KeepAwake,
        inhibitor: Inhibitor,
    },
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn power_report_matches_the_inventory_contract() {
        assert_eq!(
            serde_json::to_value(PowerReport::Reported {
                source: PowerSource::Mains,
                battery_percent: Some(80),
                keep_awake: KeepAwake::WaitingForMains,
                inhibitor: Inhibitor::Failed {
                    reason: "Access denied".into()
                },
            })
            .unwrap(),
            json!({
                "kind": "reported",
                "source": "mains",
                "batteryPercent": 80,
                "keepAwake": "waiting-for-mains",
                "inhibitor": { "kind": "failed", "reason": "Access denied" }
            })
        );
        assert_eq!(
            serde_json::to_value(PowerReport::Reported {
                source: PowerSource::Unknown,
                battery_percent: None,
                keep_awake: KeepAwake::Off,
                inhibitor: Inhibitor::None,
            })
            .unwrap(),
            json!({
                "kind": "reported",
                "source": "unknown",
                "batteryPercent": null,
                "keepAwake": "off",
                "inhibitor": { "kind": "none" }
            })
        );
        assert_eq!(
            serde_json::to_value(PowerReport::Unreported).unwrap(),
            json!({ "kind": "unreported" })
        );
    }
}
