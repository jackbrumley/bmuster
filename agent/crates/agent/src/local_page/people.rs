//! Who may sign in to the local page with their own code (SPEC-AGENT-LOCAL
//! 7): the list the server sends in a check-in reply when it changes, kept in
//! `local-users.json` (owner-only) so it works while the server is away.

use crate::identity::{check_private, write_private};
use crate::paths::LOCAL_USERS_FILE;
use anyhow::{Context as _, Result};
use bmuster_protocol::{LocalUser, LocalUsersHeld, LocalUsersUpdate};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{RwLock, RwLockReadGuard, RwLockWriteGuard};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Saved {
    hash: String,
    users: Vec<LocalUser>,
}

/// What the gate signs people in against.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Mode {
    /// No list yet (a server older than per-person codes): the shared
    /// machine code works, as before.
    Shared,
    /// Only these people's own codes work.
    People(Vec<LocalUser>),
    /// The saved list cannot be read: nobody signs in until the next
    /// check-in brings a new one. Never falls back to the shared code.
    Damaged,
}

pub struct People {
    path: PathBuf,
    state: RwLock<State>,
}

#[derive(Debug, Clone)]
enum State {
    None,
    Held(Saved),
    Damaged,
}

impl People {
    /// Reads the saved list from the data folder.
    pub fn load(dir: &Path) -> Self {
        let path = dir.join(LOCAL_USERS_FILE);
        let state = if path.exists() {
            match read(&path) {
                Ok(saved) => State::Held(saved),
                Err(e) => {
                    log::warn!(
                        "Local page: {e:#}; nobody can sign in until the next check-in brings a new list."
                    );
                    State::Damaged
                }
            }
        } else {
            State::None
        };
        Self {
            path,
            state: RwLock::new(state),
        }
    }

    fn read_state(&self) -> RwLockReadGuard<'_, State> {
        // panic = "abort": a poisoned lock cannot hold half-made changes.
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn write_state(&self) -> RwLockWriteGuard<'_, State> {
        self.state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn mode(&self) -> Mode {
        match &*self.read_state() {
            State::None => Mode::Shared,
            State::Held(saved) => Mode::People(saved.users.clone()),
            State::Damaged => Mode::Damaged,
        }
    }

    /// What the next check-in says the agent holds. A damaged list counts
    /// as none, so the server sends it again.
    pub fn held(&self) -> LocalUsersHeld {
        match &*self.read_state() {
            State::Held(saved) => LocalUsersHeld::Held {
                hash: saved.hash.clone(),
            },
            State::None | State::Damaged => LocalUsersHeld::None,
        }
    }

    /// Takes a check-in reply's list: saved first, then used.
    pub fn apply(&self, update: &LocalUsersUpdate) -> Result<()> {
        let LocalUsersUpdate::List { hash, users } = update else {
            return Ok(());
        };
        let saved = Saved {
            hash: hash.clone(),
            users: users.clone(),
        };
        write_private(&self.path, &serde_json::to_vec(&saved)?)?;
        *self.write_state() = State::Held(saved);
        log::info!(
            "Local page: {} {} may sign in with their own code.",
            users.len(),
            if users.len() == 1 { "person" } else { "people" }
        );
        Ok(())
    }
}

fn read(path: &Path) -> Result<Saved> {
    check_private(path)?;
    let text = fs::read(path).with_context(|| format!("could not read {}", path.display()))?;
    serde_json::from_slice(&text).with_context(|| format!("{} is damaged", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(id: &str, name: &str) -> LocalUser {
        LocalUser {
            user_id: id.into(),
            name: name.into(),
        }
    }

    #[test]
    fn no_list_means_the_shared_code() {
        let dir = tempfile::tempdir().unwrap();
        let people = People::load(dir.path());
        assert_eq!(people.mode(), Mode::Shared);
        assert_eq!(people.held(), LocalUsersHeld::None);
        // An unchanged reply changes nothing.
        people.apply(&LocalUsersUpdate::Unchanged).unwrap();
        assert_eq!(people.mode(), Mode::Shared);
    }

    /// P5: kept on disk, private, and read back after a restart (offline).
    #[test]
    fn a_list_is_kept_privately_and_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        let people = People::load(dir.path());
        people
            .apply(&LocalUsersUpdate::List {
                hash: "h1".into(),
                users: vec![user("a", "Ann"), user("b", "Ben")],
            })
            .unwrap();
        assert_eq!(people.held(), LocalUsersHeld::Held { hash: "h1".into() });
        let path = dir.path().join(LOCAL_USERS_FILE);
        check_private(&path).unwrap();

        let again = People::load(dir.path());
        assert_eq!(
            again.mode(),
            Mode::People(vec![user("a", "Ann"), user("b", "Ben")])
        );

        // A later list replaces it: Ben was removed.
        again
            .apply(&LocalUsersUpdate::List {
                hash: "h2".into(),
                users: vec![user("a", "Ann")],
            })
            .unwrap();
        assert_eq!(again.mode(), Mode::People(vec![user("a", "Ann")]));
        assert_eq!(
            People::load(dir.path()).held(),
            LocalUsersHeld::Held { hash: "h2".into() }
        );
    }

    #[test]
    fn a_damaged_list_lets_nobody_in_and_asks_for_it_again() {
        let dir = tempfile::tempdir().unwrap();
        write_private(&dir.path().join(LOCAL_USERS_FILE), b"not json").unwrap();
        let people = People::load(dir.path());
        assert_eq!(people.mode(), Mode::Damaged);
        assert_eq!(people.held(), LocalUsersHeld::None);
    }
}
