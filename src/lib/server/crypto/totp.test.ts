import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { localUserSecret, totpCode, totpSecondsLeft } from './totp.ts';

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

/** The vectors the agent's `totp::tests` checks too (SPEC-AGENT-LOCAL 7, P1). */
const vectorsSchema = z.object({
	localUserCodes: z.object({
		machineSecretHex: z.string(),
		users: z
			.array(
				z.object({
					userId: z.string(),
					userSecretHex: z.string(),
					codes: z.array(z.object({ unixSeconds: z.number(), code: z.string() })).min(1)
				})
			)
			.min(2)
	})
});

describe('per-person local page codes (SPEC-AGENT-LOCAL 7)', () => {
	it('P1: derives the same secrets and codes as the shared vectors', () => {
		const vectors = vectorsSchema.parse(
			JSON.parse(readFileSync('agent/crates/protocol/tests/vectors.json', 'utf8'))
		).localUserCodes;
		const machine = Buffer.from(vectors.machineSecretHex, 'hex');
		for (const user of vectors.users) {
			const secret = localUserSecret(machine, user.userId);
			expect(secret.toString('hex')).toBe(user.userSecretHex);
			for (const { unixSeconds, code } of user.codes) {
				expect(totpCode(secret, unixSeconds)).toBe(code);
			}
		}
	});

	it("gives each person a different code from the machine's", () => {
		const machine = Buffer.from('12345678901234567890', 'ascii');
		const ann = localUserSecret(machine, 'ann');
		expect(ann).toHaveLength(20);
		expect(ann.equals(localUserSecret(machine, 'ben'))).toBe(false);
		expect(ann.equals(machine)).toBe(false);
	});
});
