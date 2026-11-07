import { describe, expect, it } from 'vitest';
import { passwordSchema } from '#lib/schemas/auth/sign-in.ts';
import { hashPassword, verifyPassword } from './passwords.ts';

describe('passwords (S2)', () => {
	it('stores only an Argon2id hash that verifies the right password and no other', async () => {
		const hash = await hashPassword('twelve chars');
		expect(hash.startsWith('$argon2id$')).toBe(true);
		expect(hash).not.toContain('twelve chars');
		expect(await verifyPassword(hash, 'twelve chars')).toBe(true);
		expect(await verifyPassword(hash, 'twelve charz')).toBe(false);
	});

	it('needs at least 12 characters', async () => {
		expect(passwordSchema.safeParse('elevenchars').success).toBe(false);
		expect(passwordSchema.safeParse('twelve chars').success).toBe(true);
		await expect(hashPassword('elevenchars')).rejects.toThrow();
	});
});
