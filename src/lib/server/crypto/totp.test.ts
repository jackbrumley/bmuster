import { describe, expect, it } from 'vitest';
import { totpCode, totpSecondsLeft } from './totp.ts';

/**
 * RFC 6238 Appendix B, SHA-1: the secret is the ASCII digits "12345678901234567890".
 * The agent's `totp::tests::rfc_6238_sha1_vectors` repeats this table.
 */
const RFC_SECRET = Buffer.from('12345678901234567890', 'ascii');
const RFC_VECTORS: [number, string][] = [
	[59, '94287082'],
	[1_111_111_109, '07081804'],
	[1_111_111_111, '14050471'],
	[1_234_567_890, '89005924'],
	[2_000_000_000, '69279037'],
	[20_000_000_000, '65353130']
];

describe('TOTP (SPEC-AGENT-LOCAL)', () => {
	it('matches the RFC 6238 SHA-1 vectors, and six digits are the last six', () => {
		for (const [time, expected] of RFC_VECTORS) {
			expect(totpCode(RFC_SECRET, time, 8), `T=${time}`).toBe(expected);
			expect(totpCode(RFC_SECRET, time), `T=${time}`).toBe(expected.slice(2));
		}
	});

	it('counts down to the next code', () => {
		expect(totpSecondsLeft(60)).toBe(30);
		expect(totpSecondsLeft(61)).toBe(29);
		expect(totpSecondsLeft(89.9)).toBe(1);
	});
});
