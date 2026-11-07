//! Leaving a server (SPEC-AGENT-LOCAL 3): moving to another one from the
//! local page or `bmuster-agent rejoin`, and telling the server before an
//! uninstall.
//!
//! A move enrols with the new server first, with a fresh key in a staging
//! folder, so a typo or a refused code changes nothing. Only when that works
//! is the staged identity committed (renamed to `move-pending`), the old
//! server told with a signed `leave`, and the files swapped. If the old
//! server cannot be reached the move still completes (it is often the reason
//! for moving) and the caller says so.

use crate::client::{Reply, Session, TlsMode};
use crate::identity::{self, EnrolOptions};
use crate::paths::{MOVE_PENDING_DIR, MOVE_STAGING_DIR};
use anyhow::{bail, Context as _, Result};
use bmuster_protocol::{LeaveReason, LeaveRequest, RefusalReason, LEAVE_PATH};
use std::fs;
use std::path::Path;

/// Tells the server this machine is leaving (signed with the current key).
/// The server refuses the machine from then on.
pub fn leave(session: &Session, reason: LeaveReason) -> Result<()> {
    let body = serde_json::to_vec(&LeaveRequest { reason })?;
    match session.post_signed::<serde::de::IgnoredAny>(LEAVE_PATH, &body)? {
        Reply::Ok(_) => Ok(()),
        // Already removed there: nothing left to tell.
        Reply::Refused(refusal) if refusal.reason == RefusalReason::Revoked => Ok(()),
        Reply::Refused(refusal) => bail!(
            "the server refused: {} ({})",
            refusal.message,
            refusal.reason
        ),
    }
}

pub struct MoveTarget<'a> {
    pub url: &'a str,
    pub code: &'a str,
    pub name: Option<&'a str>,
    pub tls: TlsMode,
}

/// Whether the old server heard that the machine left.
#[derive(Debug, PartialEq, Eq)]
pub enum OldServer {
    Told,
    NotTold(String),
}

#[derive(Debug)]
pub struct Moved {
    pub machine_id: String,
    pub server_url: String,
    pub old_server: OldServer,
}

/// Whether a committed move waits to be finished (by the next start).
pub fn move_pending(dir: &Path) -> bool {
    dir.join(MOVE_PENDING_DIR).is_dir()
}

/// Moves this machine to another server. `old` is the session with the
/// current server, used only for the `leave` after the new enrolment worked.
/// `before_leave` runs just before that `leave` (the local page sends its
/// waiting events then, while the old server still takes them).
pub fn move_to(
    dir: &Path,
    target: &MoveTarget<'_>,
    old: &Session,
    before_leave: &dyn Fn(),
) -> Result<Moved> {
    if move_pending(dir) {
        bail!("a move to another server is already saved; restart the agent to finish it");
    }
    let staging = dir.join(MOVE_STAGING_DIR);
    if staging.exists() {
        // Left by a move that failed part-way; it never became the identity.
        fs::remove_dir_all(&staging)
            .with_context(|| format!("could not clear {}", staging.display()))?;
    }
    let enrolled = identity::enrol(
        &staging,
        &EnrolOptions {
            url: target.url,
            code: target.code,
            name: target.name,
            tls: target.tls,
        },
    );
    let new_identity = match enrolled {
        Ok(identity) => identity,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(e.context("the new server did not accept this machine; nothing changed"));
        }
    };

    // The commit point: from here on the move completes, now or at the next start.
    fs::rename(&staging, dir.join(MOVE_PENDING_DIR))
        .context("could not save the new server's identity")?;
    log::info!(
        "Enrolled with {} as machine {}; telling the old server.",
        new_identity.server_url,
        new_identity.machine_id
    );

    before_leave();
    let old_server = match leave(old, LeaveReason::Moved) {
        Ok(()) => OldServer::Told,
        Err(e) => {
            log::warn!("Could not tell the old server that this machine moved: {e:#}");
            OldServer::NotTold(format!("{e:#}"))
        }
    };
    identity::finish_pending_move(dir)
        .context("the move is saved and finishes when the agent next starts")?;
    Ok(Moved {
        machine_id: new_identity.machine_id,
        server_url: new_identity.server_url,
        old_server,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::client::{Security, ServerUrl, Transport};
    use crate::paths::{IDENTITY_FILE, KEY_FILE, LOCAL_PAGE_SECRET_FILE};
    use bmuster_protocol::{encode_public_key, ServerTrust};
    use ed25519_dalek::SigningKey;
    use std::io::{Read as _, Write as _};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// One request a fake server saw: which server and which path.
    pub(crate) type Seen = Arc<Mutex<Vec<String>>>;

    /// A plain-HTTP server on 127.0.0.1 (the agent allows http:// only for
    /// loopback) answering every request with `status` and `body`, and
    /// recording `<name> <method> <path>` in `seen`.
    pub(crate) fn fake_server(name: &'static str, status: u16, body: &str, seen: &Seen) -> String {
        let body = body.to_string();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::clone(seen);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 4096];
                // Read the head and the body the Content-Length announces.
                loop {
                    let n = stream.read(&mut chunk).unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buffer.extend_from_slice(&chunk[..n]);
                    let text = String::from_utf8_lossy(&buffer);
                    if let Some(end) = text.find("\r\n\r\n") {
                        let length = text[..end]
                            .lines()
                            .find_map(|line| {
                                let (key, value) = line.split_once(':')?;
                                key.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().ok())?
                            })
                            .unwrap_or(0);
                        if buffer.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                let text = String::from_utf8_lossy(&buffer);
                let mut words = text.split_whitespace();
                let method = words.next().unwrap_or_default();
                let path = words.next().unwrap_or_default();
                seen.lock().unwrap().push(format!("{name} {method} {path}"));
                let reply = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(reply.as_bytes());
            }
        });
        url
    }

    fn server_key() -> String {
        encode_public_key(&SigningKey::from_bytes(&[9; 32]).verifying_key())
    }

    /// A data folder enrolled with `old_url` as machine "old-machine", and its session.
    fn enrolled(old_url: &str) -> (tempfile::TempDir, Session) {
        let dir = tempfile::tempdir().unwrap();
        identity::prepare_data_dir(dir.path()).unwrap();
        identity::save(
            dir.path(),
            &identity::Identity {
                machine_id: "old-machine".into(),
                server_url: old_url.into(),
                server_public_key: server_key(),
                check_in_seconds: 60,
                server_pin: None,
                next_pin: None,
            },
        )
        .unwrap();
        identity::write_private(&dir.path().join(KEY_FILE), &[1; 32]).unwrap();
        identity::write_private(&dir.path().join(LOCAL_PAGE_SECRET_FILE), &[2; 20]).unwrap();
        let transport = Transport::new(
            ServerUrl::parse(old_url).unwrap(),
            Security::once(TlsMode::Checked(ServerTrust::Public)),
        );
        let session = Session::new(
            transport,
            "old-machine".into(),
            SigningKey::from_bytes(&[1; 32]),
        );
        (dir, session)
    }

    fn target(url: &str) -> MoveTarget<'_> {
        MoveTarget {
            url,
            code: "K7P-4QX-29M",
            name: Some("Reception PC"),
            tls: TlsMode::Checked(ServerTrust::Public),
        }
    }

    fn enrolled_reply() -> String {
        format!(
            r#"{{"machineId":"new-machine","serverPublicKey":"{}","checkInSeconds":60}}"#,
            server_key()
        )
    }

    #[test]
    fn enrols_with_the_new_server_first_then_leaves_the_old_and_switches() {
        let seen = Seen::default();
        let old_url = fake_server("old", 200, r#"{"left":true}"#, &seen);
        let new_url = fake_server("new", 200, &enrolled_reply(), &seen);
        let (dir, session) = enrolled(&old_url);

        let hook = || seen.lock().unwrap().push("before leave".into());
        let moved = move_to(dir.path(), &target(&new_url), &session, &hook).unwrap();

        assert_eq!(
            *seen.lock().unwrap(),
            [
                "new POST /agent/v1/enrol",
                "before leave",
                "old POST /agent/v1/leave"
            ]
        );
        assert_eq!(moved.machine_id, "new-machine");
        assert_eq!(moved.old_server, OldServer::Told);
        let identity = identity::load(dir.path()).unwrap();
        assert_eq!(identity.machine_id, "new-machine");
        assert_eq!(identity.server_url, new_url);
        assert_ne!(
            identity::load_key(dir.path()).unwrap().to_bytes(),
            [1; 32],
            "a fresh key for the new server"
        );
        assert!(!dir.path().join(MOVE_PENDING_DIR).exists());
        assert!(!dir.path().join(MOVE_STAGING_DIR).exists());
        assert!(
            !dir.path().join(LOCAL_PAGE_SECRET_FILE).exists(),
            "the old server knew the local page secret; a new one is made"
        );
    }

    #[test]
    fn a_refused_code_changes_nothing_and_never_tells_the_old_server() {
        let seen = Seen::default();
        let old_url = fake_server("old", 200, r#"{"left":true}"#, &seen);
        let new_url = fake_server(
            "new",
            404,
            r#"{"reason":"invalid-code","message":"No such join code."}"#,
            &seen,
        );
        let (dir, session) = enrolled(&old_url);
        let before = std::fs::read(dir.path().join(IDENTITY_FILE)).unwrap();

        let error = move_to(dir.path(), &target(&new_url), &session, &|| {}).unwrap_err();

        assert!(format!("{error:#}").contains("No such join code"));
        assert_eq!(*seen.lock().unwrap(), ["new POST /agent/v1/enrol"]);
        assert_eq!(
            std::fs::read(dir.path().join(IDENTITY_FILE)).unwrap(),
            before
        );
        assert_eq!(identity::load_key(dir.path()).unwrap().to_bytes(), [1; 32]);
        assert!(dir.path().join(LOCAL_PAGE_SECRET_FILE).exists());
        assert!(!dir.path().join(MOVE_STAGING_DIR).exists());
        assert!(!move_pending(dir.path()));
    }

    #[test]
    fn an_unreachable_old_server_does_not_stop_the_move() {
        let seen = Seen::default();
        let new_url = fake_server("new", 200, &enrolled_reply(), &seen);
        // Nothing listens here once the listener is dropped.
        let gone = {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}", listener.local_addr().unwrap())
        };
        let (dir, session) = enrolled(&gone);

        let moved = move_to(dir.path(), &target(&new_url), &session, &|| {}).unwrap();

        assert!(matches!(moved.old_server, OldServer::NotTold(_)));
        assert_eq!(
            identity::load(dir.path()).unwrap().machine_id,
            "new-machine"
        );
    }

    #[test]
    fn a_saved_move_is_finished_at_the_next_start() {
        let seen = Seen::default();
        let old_url = fake_server("old", 200, r#"{"left":true}"#, &seen);
        let (dir, _session) = enrolled(&old_url);
        // As if the agent stopped right after the commit point.
        let pending = dir.path().join(MOVE_PENDING_DIR);
        identity::prepare_data_dir(&pending).unwrap();
        let mut staged = identity::load(dir.path()).unwrap();
        staged.machine_id = "new-machine".into();
        identity::save(&pending, &staged).unwrap();
        identity::write_private(&pending.join(KEY_FILE), &[3; 32]).unwrap();

        assert!(identity::finish_pending_move(dir.path()).unwrap());
        assert_eq!(
            identity::load(dir.path()).unwrap().machine_id,
            "new-machine"
        );
        assert_eq!(identity::load_key(dir.path()).unwrap().to_bytes(), [3; 32]);
        assert!(!pending.exists());
        assert!(!identity::finish_pending_move(dir.path()).unwrap());
    }

    #[test]
    fn leaving_a_server_that_already_removed_the_machine_is_fine() {
        let seen = Seen::default();
        let url = fake_server(
            "old",
            401,
            r#"{"reason":"revoked","message":"This machine was removed from the server."}"#,
            &seen,
        );
        let (_dir, session) = enrolled(&url);
        leave(&session, LeaveReason::Uninstalled).unwrap();
        assert_eq!(*seen.lock().unwrap(), ["old POST /agent/v1/leave"]);
    }
}
