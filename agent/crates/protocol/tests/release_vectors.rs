//! Reproduces the shared release-signing vector (SPEC-AGENT-UPDATES). The
//! TypeScript signer checks the same file, so a build signed by
//! `scripts/agent-sign.ts` is exactly what the agent verifies.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use bmuster_protocol::{encode_public_key, release_message_of, sha256_hex};
use ed25519_dalek::{Signature, Signer as _, SigningKey};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    seed_hex: String,
    public_key_base64: String,
    version: String,
    target: String,
    binary_utf8: String,
    size: u64,
    sha256: String,
    message_utf8: String,
    signature_base64: String,
}

#[test]
fn release_vector() {
    let vector: Vector = serde_json::from_str(include_str!("release-vectors.json")).unwrap();
    let seed: [u8; 32] = hex::decode(&vector.seed_hex).unwrap().try_into().unwrap();
    let key = SigningKey::from_bytes(&seed);
    assert_eq!(
        encode_public_key(&key.verifying_key()),
        vector.public_key_base64
    );

    let binary = vector.binary_utf8.as_bytes();
    assert_eq!(binary.len() as u64, vector.size);
    assert_eq!(sha256_hex(binary), vector.sha256);
    let message = release_message_of(&vector.version, &vector.target, binary);
    assert_eq!(message, vector.message_utf8);

    let signature = key.sign(message.as_bytes());
    assert_eq!(BASE64.encode(signature.to_bytes()), vector.signature_base64);
    let decoded: [u8; 64] = BASE64
        .decode(&vector.signature_base64)
        .unwrap()
        .try_into()
        .unwrap();
    key.verifying_key()
        .verify_strict(message.as_bytes(), &Signature::from_bytes(&decoded))
        .unwrap();
}
