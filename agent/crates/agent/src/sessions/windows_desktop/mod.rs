//! Desktop sessions on Windows (SPEC-DESKTOP 6.2). The agent is a
//! LocalSystem service in session 0, which has no screen, so it runs each
//! desktop session in `bmuster-agent desktop-helper`, started in the active
//! console session ([`supervisor`]). The helper ([`helper`]) checks the
//! ticket again, opens the session socket itself and follows the input
//! desktop. Ctrl+Alt+Del comes back to the service, which alone may call
//! `SendSAS` ([`sas`]).

pub mod helper;
pub mod sas;
pub mod supervisor;

use super::pump::Ended;
use super::{fail, Inner, TicketText};
use crate::socket::{connect_to, Connect};
use anyhow::{anyhow, Result};
use bmuster_protocol::session::{session_socket_path, SessionTicket};
use supervisor::Outcome;

/// Runs a desktop session through the helper; the service's session thread
/// waits here until it ends.
pub(super) fn serve(inner: &Inner, ticket: &SessionTicket, text: &TicketText) -> Result<Ended> {
    let outcome = match supervisor::supervisor() {
        Ok(supervisor) => supervisor.run_session(
            &ticket.session_id,
            &text.ticket,
            &text.signature,
            inner.session.server_now_ms(),
            inner.session.clock_offset_ms(),
            &inner.stop,
        ),
        Err(message) => Outcome::Failed(format!("The desktop helper cannot start: {message}")),
    };
    match outcome {
        Outcome::Ended(reason) => {
            log::info!(
                "Desktop session {} ended in the helper: {reason}",
                ticket.session_id
            );
            Ok(Ended::Finished)
        }
        // The helper never opened the session's socket: say why on it.
        Outcome::Failed(message) => {
            let path = session_socket_path(&ticket.session_id);
            match connect_to(&inner.session, &path)? {
                Connect::Open(mut socket) => fail(&mut socket, &anyhow!(message)),
                Connect::Revoked(refused) => {
                    anyhow::bail!("the server refused the session socket: {refused}")
                }
            }
        }
    }
}
