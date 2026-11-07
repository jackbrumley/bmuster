//! Reproduces the shared signing vectors byte for byte (SPEC-ENROLMENT A11).
//! The TypeScript side checks the same file in `signing.test.ts`.

use bmuster_protocol::{authorization_header, encode_public_key, sign_request, signing_message};
use ed25519_dalek::SigningKey;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vectors {
    seed_hex: String,
    public_key_base64: String,
    machine_id: String,
    requests: Vec<Request>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    method: String,
    path: String,
    timestamp_ms: i64,
    body: String,
    message_utf8: String,
    signature_base64: String,
    authorization: String,
}

#[test]
fn vectors() {
    let vectors: Vectors = serde_json::from_str(include_str!("vectors.json")).unwrap();
    let seed: [u8; 32] = hex::decode(&vectors.seed_hex).unwrap().try_into().unwrap();
    let key = SigningKey::from_bytes(&seed);

    assert_eq!(
        encode_public_key(&key.verifying_key()),
        vectors.public_key_base64
    );
    assert!(!vectors.requests.is_empty());

    for request in &vectors.requests {
        let body = request.body.as_bytes();
        assert_eq!(
            signing_message(&request.method, &request.path, request.timestamp_ms, body),
            request.message_utf8
        );

        let signature = sign_request(
            &key,
            &request.method,
            &request.path,
            request.timestamp_ms,
            body,
        );
        let header = authorization_header(&vectors.machine_id, request.timestamp_ms, &signature);
        let encoded = header.rsplit(':').next().unwrap();
        assert_eq!(encoded, request.signature_base64);
        assert_eq!(header, request.authorization);
    }
}
