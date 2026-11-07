//! The `SoftwareSASGeneration` policy (SPEC-DESKTOP 5.3): `SendSAS` only
//! works from a service when the policy allows services. The installer (and
//! the first Ctrl+Alt+Del on an agent installed before this) sets it and
//! records what was there; the uninstaller puts that back.
//!
//! Values: 0 or missing, nobody; 1 services; 2 Ease of Access programs;
//! 3 both.

use serde::{Deserialize, Serialize};

/// Under `HKEY_LOCAL_MACHINE`.
pub const POLICY_KEY: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System";
pub const POLICY_VALUE: &str = "SoftwareSASGeneration";
/// The record's file name in the agent's data folder.
pub const RECORD_FILE: &str = "sas-policy.json";

/// Whether services may send Ctrl+Alt+Del with this value.
pub fn allows_services(value: Option<u32>) -> bool {
    matches!(value, Some(1 | 3))
}

/// The value to write so services may send Ctrl+Alt+Del, or `None` when the
/// current one already allows it. Ease of Access programs keep their right.
pub fn value_to_set(current: Option<u32>) -> Option<u32> {
    match current {
        Some(1 | 3) => None,
        Some(2) => Some(3),
        _ => Some(1),
    }
}

/// What BMuster changed: the value before (`None`: there was none) and the
/// value it wrote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Record {
    pub before: Option<u32>,
    pub set: u32,
}

/// What the uninstaller does to the value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Restore {
    /// BMuster did not change it, or someone changed it since: leave it.
    Leave,
    /// There was no value before BMuster's.
    Delete,
    Set(u32),
}

/// Works out the uninstaller's step from the record and the value now.
pub fn restore(record: Option<&Record>, now: Option<u32>) -> Restore {
    match record {
        None => Restore::Leave,
        Some(record) if now != Some(record.set) => Restore::Leave,
        Some(Record { before: None, .. }) => Restore::Delete,
        Some(Record {
            before: Some(value),
            ..
        }) => Restore::Set(*value),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sas_policy_is_set_only_when_services_cannot_send_it() {
        assert_eq!(value_to_set(None), Some(1));
        assert_eq!(value_to_set(Some(0)), Some(1));
        assert_eq!(value_to_set(Some(1)), None);
        assert_eq!(value_to_set(Some(2)), Some(3));
        assert_eq!(value_to_set(Some(3)), None);
        assert_eq!(value_to_set(Some(7)), Some(1));
        assert!(allows_services(Some(1)) && allows_services(Some(3)));
        assert!(!allows_services(None) && !allows_services(Some(2)));
    }

    #[test]
    fn sas_policy_uninstall_restores_only_what_bmuster_set() {
        let none_before = Record {
            before: None,
            set: 1,
        };
        let two_before = Record {
            before: Some(2),
            set: 3,
        };
        assert_eq!(restore(None, Some(1)), Restore::Leave);
        assert_eq!(restore(Some(&none_before), Some(1)), Restore::Delete);
        assert_eq!(restore(Some(&two_before), Some(3)), Restore::Set(2));
        // An admin changed it after BMuster: theirs stays.
        assert_eq!(restore(Some(&none_before), Some(0)), Restore::Leave);
        assert_eq!(restore(Some(&none_before), None), Restore::Leave);
    }

    #[test]
    fn sas_policy_record_is_camel_case_json() {
        let record = Record {
            before: None,
            set: 1,
        };
        let json = serde_json::to_string(&record).unwrap();
        assert_eq!(json, r#"{"before":null,"set":1}"#);
        assert_eq!(serde_json::from_str::<Record>(&json).unwrap(), record);
    }
}
