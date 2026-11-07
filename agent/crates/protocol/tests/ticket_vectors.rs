//! Opens the shared session ticket vectors (SPEC-SESSIONS T3). The server's
//! `session-ticket.test.ts` signs the same tickets and must produce these
//! bytes exactly.

use bmuster_protocol::decode_public_key;
use bmuster_protocol::session::{open_ticket, SessionTicket};
use ed25519_dalek::SigningKey;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    seed_hex: String,
    public_key_base64: String,
    machine_id: String,
    now_ms: i64,
    tickets: Vec<Vector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    ticket: SessionTicket,
    ticket_json: String,
    ticket_base64: String,
    signature_base64: String,
}

#[test]
fn ticket_vectors() {
    let vectors: Vectors = serde_json::from_str(include_str!("ticket-vectors.json")).unwrap();
    let seed: [u8; 32] = hex::decode(&vectors.seed_hex).unwrap().try_into().unwrap();
    let key = SigningKey::from_bytes(&seed).verifying_key();
    assert_eq!(decode_public_key(&vectors.public_key_base64).unwrap(), key);
    assert!(!vectors.tickets.is_empty());

    for vector in &vectors.tickets {
        let opened = open_ticket(
            &key,
            &vector.ticket_base64,
            &vector.signature_base64,
            &vectors.machine_id,
            vectors.now_ms,
        );
        // Each vector carries the permission its purpose needs.
        assert_eq!(
            opened.as_ref(),
            Ok(&vector.ticket),
            "{}",
            vector.ticket_json
        );
        assert_eq!(
            serde_json::to_string(&vector.ticket).unwrap(),
            vector.ticket_json,
            "field order matches the server's"
        );
    }
}
