//! Time-based one-time codes (RFC 6238 over RFC 4226): HMAC-SHA1, 30-second
//! steps, 6 digits. The local page's sign-in code; the server computes the
//! same code from the same secret for the console (SPEC-AGENT-LOCAL).

use ring::hmac;

pub const SECRET_BYTES: usize = 20;
pub const STEP_SECONDS: u64 = 30;
pub const DIGITS: u32 = 6;

/// The 30-second step a Unix time (seconds) falls in.
pub fn step_at(unix_seconds: u64) -> u64 {
    unix_seconds / STEP_SECONDS
}

/// The code for one step, `digits` long (RFC 4226 section 5.3).
pub fn code_for_step(secret: &[u8], step: u64, digits: u32) -> String {
    let key = hmac::Key::new(hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY, secret);
    let tag = hmac::sign(&key, &step.to_be_bytes());
    let mac = tag.as_ref();
    let offset = usize::from(mac[mac.len() - 1] & 0x0f);
    let binary = (u32::from(mac[offset]) & 0x7f) << 24
        | u32::from(mac[offset + 1]) << 16
        | u32::from(mac[offset + 2]) << 8
        | u32::from(mac[offset + 3]);
    let value = binary % 10u32.pow(digits);
    format!("{value:0width$}", width = digits as usize)
}

/// The step whose code matches `code`, allowing one step either side for a
/// clock that is a little off. `None` when nothing matches.
pub fn matching_step(secret: &[u8], code: &str, unix_seconds: u64) -> Option<u64> {
    if code.len() != DIGITS as usize || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let now = step_at(unix_seconds);
    [now, now.saturating_sub(1), now + 1]
        .into_iter()
        .find(|step| {
            constant_time_eq(
                code_for_step(secret, *step, DIGITS).as_bytes(),
                code.as_bytes(),
            )
        })
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    /// RFC 6238 Appendix B, SHA-1 column: the secret is the ASCII digits
    /// "12345678901234567890". The server's `totp.test.ts` repeats this table.
    const RFC_SECRET: &[u8] = b"12345678901234567890";
    const RFC_VECTORS: [(u64, &str); 6] = [
        (59, "94287082"),
        (1_111_111_109, "07081804"),
        (1_111_111_111, "14050471"),
        (1_234_567_890, "89005924"),
        (2_000_000_000, "69279037"),
        (20_000_000_000, "65353130"),
    ];

    #[test]
    fn rfc_6238_sha1_vectors() {
        for (time, expected) in RFC_VECTORS {
            assert_eq!(
                code_for_step(RFC_SECRET, step_at(time), 8),
                expected,
                "T={time}"
            );
            // Six digits are the last six of the eight.
            assert_eq!(
                code_for_step(RFC_SECRET, step_at(time), DIGITS),
                expected[2..],
                "T={time}"
            );
        }
    }

    #[test]
    fn a_code_matches_its_step_and_one_either_side_only() {
        let now = 1_111_111_111;
        let code = code_for_step(RFC_SECRET, step_at(now), DIGITS);
        assert_eq!(matching_step(RFC_SECRET, &code, now), Some(step_at(now)));
        assert_eq!(
            matching_step(RFC_SECRET, &code, now + STEP_SECONDS),
            Some(step_at(now))
        );
        assert_eq!(
            matching_step(RFC_SECRET, &code, now - STEP_SECONDS),
            Some(step_at(now))
        );
        assert_eq!(
            matching_step(RFC_SECRET, &code, now + 3 * STEP_SECONDS),
            None
        );
        assert_eq!(matching_step(RFC_SECRET, "12345", now), None);
        assert_eq!(matching_step(RFC_SECRET, "12345a", now), None);
    }
}
