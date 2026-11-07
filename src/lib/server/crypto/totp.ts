import { createHmac } from 'node:crypto';

/**
 * Time-based one-time codes (RFC 6238 over RFC 4226): HMAC-SHA1, 30-second
 * steps. The agent's local page checks the same codes (agent/crates/agent/src/totp.rs).
 */
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;

/** The code for the step `unixSeconds` falls in, `digits` long. */
export function totpCode(
	secret: Buffer,
	unixSeconds: number,
	digits: number = TOTP_DIGITS
): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(unixSeconds / TOTP_STEP_SECONDS)));
	const mac = createHmac('sha1', secret).update(counter).digest();
	const offset = (mac.at(-1) ?? 0) & 0x0f;
	const binary = mac.readUInt32BE(offset) & 0x7f_ff_ff_ff;
	return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Seconds until the code shown at `unixSeconds` changes (1 to 30). */
export function totpSecondsLeft(unixSeconds: number): number {
	return TOTP_STEP_SECONDS - (Math.floor(unixSeconds) % TOTP_STEP_SECONDS);
}

/** First line of the per-person derivation; the agent's `totp::USER_DOMAIN` is the same. */
const LOCAL_USER_DOMAIN = 'BMUSTER-LOCAL-USER-1';
const LOCAL_USER_SECRET_BYTES = 20;

/**
 * A person's own local page key (SPEC-AGENT-LOCAL 7): the first 20 bytes of
 * HMAC-SHA256(machine secret, "BMUSTER-LOCAL-USER-1\n" + userId). The agent derives the same key,
 * so it can tell whose code signed in.
 */
export function localUserSecret(machineSecret: Buffer, userId: string): Buffer {
	return createHmac('sha256', machineSecret)
		.update(`${LOCAL_USER_DOMAIN}\n${userId}`, 'utf8')
		.digest()
		.subarray(0, LOCAL_USER_SECRET_BYTES);
}
