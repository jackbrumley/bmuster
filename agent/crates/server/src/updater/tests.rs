//! The updater's rules against a fake service and release source
//! (SPEC-SERVER-UPDATES SU3, SU5 to SU7).

use super::*;
use crate::layout::tests::{fake_bundle_named, scratch};
use crate::updates::archive::tests::archive_of;
use crate::updates::manifest::tests::{manifest_for, signed};
use crate::updates::TARGET;
use ed25519_dalek::SigningKey;
use sha2::{Digest as _, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::PathBuf;

const OLD: &str = "1.0.0";
const NEW: &str = "1.1.0";

fn key() -> SigningKey {
    SigningKey::from_bytes(&[21; 32])
}

/// Serves a newest version and its assets from memory.
struct FakeSource {
    latest: String,
    assets: HashMap<String, Vec<u8>>,
    opened: RefCell<Vec<String>>,
}

impl Source for FakeSource {
    fn latest(&self) -> Result<String> {
        Ok(self.latest.clone())
    }
    fn open(&self, version: &str, asset: &str) -> Result<Box<dyn Read>> {
        self.opened.borrow_mut().push(format!("{version}/{asset}"));
        match self.assets.get(asset) {
            Some(bytes) => Ok(Box::new(std::io::Cursor::new(bytes.clone()))),
            None => bail!("no asset {asset}"),
        }
    }
}

/// Records calls; on start, the app of the release `current` points at
/// reports ready unless that version is in `broken`.
struct FakeService {
    layout: Layout,
    broken: Vec<String>,
    calls: RefCell<Vec<String>>,
}

impl Service for FakeService {
    fn stop(&self) -> Result<()> {
        self.calls.borrow_mut().push("stop".into());
        Ok(())
    }
    fn start(&self) -> Result<()> {
        let running = current_version(&self.layout.program)?.unwrap();
        self.calls.borrow_mut().push(format!("start {running}"));
        let record = Switch::load(&self.layout.switch_record())?;
        if let Some(switch) = record.filter(|s| s.to == running) {
            if !self.broken.contains(&running) {
                let ready = serde_json::json!({ "nonce": switch.nonce, "version": running });
                fs::write(self.layout.ready_file(), ready.to_string())?;
            }
        }
        Ok(())
    }
    fn refresh(&self, release: &Path) -> Result<()> {
        let name = release.file_name().unwrap().to_string_lossy();
        self.calls.borrow_mut().push(format!("refresh {name}"));
        Ok(())
    }
}

struct Rig {
    root: PathBuf,
    layout: Layout,
    source: FakeSource,
    service: FakeService,
    keys: Vec<VerifyingKey>,
}

/// An install of OLD (current), a database, and NEW on offer, signed
/// with the test key, declaring rollback to `rollback`.
fn make_rig(name: &str, rollback: &[&str], broken: &[&str]) -> Rig {
    let root = scratch(name);
    let layout = Layout {
        program: root.join("opt"),
        data: root.join("data"),
    };
    fs::create_dir_all(&layout.data).unwrap();
    fs::write(layout.database(), b"database").unwrap();
    let old = fake_bundle_named(&root, "old", OLD);
    releases::place(&old, &layout.program, OLD).unwrap();
    point_current(&layout.program, OLD).unwrap();
    let archive = new_release_archive(NEW);
    let manifest = manifest_for(
        NEW,
        archive.len() as u64,
        &hex::encode(Sha256::digest(&archive)),
        rollback,
    );
    let mut assets = HashMap::new();
    assets.insert(manifest::manifest_name(TARGET), signed(&manifest, &key()));
    assets.insert(manifest::archive_name(TARGET), archive);
    Rig {
        source: FakeSource {
            latest: NEW.into(),
            assets,
            opened: RefCell::new(vec![]),
        },
        service: FakeService {
            layout: layout.clone(),
            broken: broken.iter().map(|v| v.to_string()).collect(),
            calls: RefCell::new(vec![]),
        },
        keys: vec![key().verifying_key()],
        root,
        layout,
    }
}

fn new_release_archive(version: &str) -> Vec<u8> {
    let node = if cfg!(windows) {
        "node/node.exe"
    } else {
        "node/bin/node"
    };
    let package = format!("{{\"version\":\"{version}\"}}");
    let version_file = format!("{version}\n");
    archive_of(&[
        (crate::layout::LAUNCHER, b"launcher", 0o755),
        (node, b"node", 0o755),
        ("app/server.js", b"//", 0o644),
        ("app/package.json", package.as_bytes(), 0o644),
        ("releases/agents", b"", 0o644),
        ("VERSION", version_file.as_bytes(), 0o644),
    ])
}

impl Rig {
    fn updater(&self) -> Updater<'_> {
        Updater {
            layout: &self.layout,
            keys: &self.keys,
            target: TARGET,
            service: &self.service,
            source: &self.source,
            health_window: Duration::from_millis(600),
        }
    }
    fn request(&self) {
        fs::write(self.layout.update_flag(), b"").unwrap();
    }
    fn current(&self) -> String {
        current_version(&self.layout.program).unwrap().unwrap()
    }
    fn status(&self) -> files::Status {
        files::read_status(&self.layout).unwrap().unwrap()
    }
    fn calls(&self) -> Vec<String> {
        self.service.calls.borrow().clone()
    }
}

impl Drop for Rig {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn flag_is_only_a_trigger() {
    // No flag: nothing is fetched, nothing is touched.
    let rig = make_rig("updater-flag-none", &[OLD], &[]);
    assert_eq!(rig.updater().update().unwrap(), Outcome::NothingToDo);
    assert!(rig.source.opened.borrow().is_empty());
    assert!(rig.calls().is_empty());

    // A flag naming an older version (or anything else) changes nothing:
    // the updater picks the newest signed release itself.
    fs::write(rig.layout.update_flag(), br#"{"version":"0.0.1"}"#).unwrap();
    assert_eq!(rig.updater().update().unwrap(), Outcome::Healthy);
    assert_eq!(rig.current(), NEW);
    assert!(!rig.layout.update_flag().exists());

    // A flag that is a link: deleted, its target untouched.
    #[cfg(unix)]
    {
        let rig = make_rig("updater-flag-link", &[OLD], &[]);
        let target = rig.root.join("precious");
        fs::write(&target, b"keep").unwrap();
        std::os::unix::fs::symlink(&target, rig.layout.update_flag()).unwrap();
        assert_eq!(rig.updater().update().unwrap(), Outcome::Healthy);
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        assert!(fs::symlink_metadata(rig.layout.update_flag()).is_err());
    }

    // A folder where the flag should be is refused, and nothing runs.
    let rig = make_rig("updater-flag-dir", &[OLD], &[]);
    fs::create_dir(rig.layout.update_flag()).unwrap();
    assert!(rig.updater().update().is_err());
    assert_eq!(rig.current(), OLD);

    // A linked data folder is refused before anything else.
    #[cfg(unix)]
    {
        let rig = make_rig("updater-flag-linked-data", &[OLD], &[]);
        let linked = rig.root.join("linked");
        std::os::unix::fs::symlink(&rig.layout.data, &linked).unwrap();
        fs::write(rig.layout.update_flag(), b"").unwrap();
        let layout = Layout {
            program: rig.layout.program.clone(),
            data: linked,
        };
        let updater = Updater {
            layout: &layout,
            ..rig.updater()
        };
        assert!(updater.update().is_err());
        assert!(rig.layout.update_flag().exists());
    }

    // One updater at a time: the lock is held while one runs.
    let rig = make_rig("updater-flag-lock", &[OLD], &[]);
    let held = rig.updater().lock().unwrap();
    assert!(File::open(rig.layout.update_lock())
        .unwrap()
        .try_lock()
        .is_err());
    drop(held);
}

#[test]
fn refused_releases_change_nothing() {
    // Signed by a key this build does not trust.
    let mut rig = make_rig("updater-refused-key", &[OLD], &[]);
    rig.keys = vec![SigningKey::from_bytes(&[22; 32]).verifying_key()];
    rig.request();
    assert_eq!(rig.updater().update().unwrap(), Outcome::Failed);
    assert_eq!(rig.current(), OLD);
    assert!(rig
        .status()
        .message
        .contains("not from a trusted release key"));
    assert!(rig.calls().is_empty());
    assert!(!release_dir(&rig.layout.program, NEW).exists());

    // An archive that differs from its signed hash.
    let mut rig = make_rig("updater-refused-hash", &[OLD], &[]);
    let archive = rig
        .source
        .assets
        .get_mut(&manifest::archive_name(TARGET))
        .unwrap();
    let last = archive.len() - 1;
    archive[last] ^= 1;
    rig.request();
    assert_eq!(rig.updater().update().unwrap(), Outcome::Failed);
    assert_eq!(rig.current(), OLD);
    assert!(rig.status().message.contains("hash or size"));
    assert!(!release_dir(&rig.layout.program, NEW).exists());

    // Nothing newer: up to date, nothing downloaded.
    let mut rig = make_rig("updater-refused-older", &[OLD], &[]);
    rig.source.latest = OLD.into();
    rig.request();
    assert_eq!(rig.updater().update().unwrap(), Outcome::UpToDate);
    assert_eq!(rig.source.opened.borrow().len(), 0);
}

#[test]
fn switch_keeps_previous_and_prunes() {
    let rig = make_rig("updater-switch", &[OLD], &[]);
    let ancient = fake_bundle_named(&rig.root, "ancient", "0.9.0");
    releases::place(&ancient, &rig.layout.program, "0.9.0").unwrap();
    rig.request();
    assert_eq!(rig.updater().update().unwrap(), Outcome::Healthy);
    assert_eq!(rig.current(), NEW);
    assert!(release_dir(&rig.layout.program, OLD).exists());
    assert!(!release_dir(&rig.layout.program, "0.9.0").exists());
    assert!(!rig.layout.switch_record().exists());
    assert_eq!(
        rig.calls(),
        ["stop", &format!("refresh {NEW}"), &format!("start {NEW}")]
    );
    let status = rig.status();
    assert_eq!(status.phase, Phase::Healthy);
    assert_eq!(status.to.as_deref(), Some(NEW));
    // The database was copied before the switch, never replaced.
    let copy = rig
        .layout
        .backups()
        .join(format!("pre-update-{OLD}-to-{NEW}.db"));
    assert_eq!(fs::read(copy).unwrap(), b"database");
    assert_eq!(fs::read(rig.layout.database()).unwrap(), b"database");
}

#[test]
fn health_commit_and_rollback_rules() {
    // Unhealthy, compatible: back to the old release, with the reason.
    let rig = make_rig("updater-health-compatible", &[OLD], &[NEW]);
    rig.request();
    assert_eq!(rig.updater().update().unwrap(), Outcome::RolledBack);
    assert_eq!(rig.current(), OLD);
    let status = rig.status();
    assert_eq!(status.phase, Phase::RolledBack);
    assert!(
        status.message.contains("did not report ready"),
        "{status:?}"
    );
    assert!(!rig.layout.switch_record().exists());
    assert_eq!(
        rig.calls(),
        [
            "stop",
            &format!("refresh {NEW}"),
            &format!("start {NEW}"),
            "stop",
            &format!("refresh {OLD}"),
            &format!("start {OLD}"),
        ]
    );

    // Unhealthy, not declared compatible: stopped, never rolled back,
    // and the instructions name the database copy.
    let rig = make_rig("updater-health-incompatible", &[], &[NEW]);
    rig.request();
    assert_eq!(rig.updater().update().unwrap(), Outcome::Failed);
    assert_eq!(rig.current(), NEW);
    let status = rig.status();
    assert_eq!(status.phase, Phase::Failed);
    assert!(status.message.contains("server is stopped"), "{status:?}");
    assert!(status.message.contains("pre-update-1.0.0-to-1.1.0.db"));
    assert_eq!(rig.calls().last().map(String::as_str), Some("stop"));
    assert_eq!(fs::read(rig.layout.database()).unwrap(), b"database");

    // A ready file with another nonce or version does not count.
    let rig = make_rig("updater-health-stale", &[OLD], &[NEW]);
    fs::write(
        rig.layout.ready_file(),
        serde_json::json!({ "nonce": "a".repeat(64), "version": NEW }).to_string(),
    )
    .unwrap();
    rig.request();
    assert_eq!(rig.updater().update().unwrap(), Outcome::RolledBack);
}

#[test]
fn recover_from_every_step() {
    for (step, compatible, expected, phase) in [
        (Step::Switching, true, OLD, Phase::Failed),
        (Step::Switching, false, OLD, Phase::Failed),
        (Step::Starting, true, OLD, Phase::RolledBack),
        (Step::Starting, false, NEW, Phase::Failed),
        (Step::RollingBack, true, OLD, Phase::RolledBack),
    ] {
        for at_boot in [true, false] {
            // Both "current" states an interruption can leave behind.
            for pointed in [OLD, NEW] {
                let rig = make_rig("updater-recover", &[], &[]);
                let new = fake_bundle_named(&rig.root, "new", NEW);
                releases::place(&new, &rig.layout.program, NEW).unwrap();
                point_current(&rig.layout.program, pointed).unwrap();
                Switch {
                    from: OLD.into(),
                    to: NEW.into(),
                    step,
                    nonce: "b".repeat(64),
                    rollback_compatible: compatible,
                }
                .save(&rig.layout.switch_record())
                .unwrap();
                let updater = rig.updater();
                let outcome = if at_boot {
                    updater.recover_at_boot().unwrap()
                } else {
                    updater.update().unwrap()
                };
                let case = format!("{step:?} {compatible} boot={at_boot} at={pointed}");
                assert_eq!(outcome, Outcome::Recovered, "{case}");
                assert_eq!(rig.current(), expected, "{case}");
                assert_eq!(rig.status().phase, phase, "{case}");
                assert!(!rig.layout.switch_record().exists(), "{case}");
                if at_boot {
                    assert!(rig.calls().is_empty(), "{case}");
                } else {
                    assert_eq!(
                        rig.calls(),
                        ["stop", &format!("start {expected}")],
                        "{case}"
                    );
                }
                // Running it again finds nothing left to do.
                assert_eq!(updater.recover_at_boot().unwrap(), Outcome::NothingToDo);
                assert_eq!(rig.current(), expected, "{case}");
                assert_eq!(fs::read(rig.layout.database()).unwrap(), b"database");
            }
        }
    }
}
