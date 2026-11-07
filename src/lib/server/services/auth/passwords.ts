import { hash, verify } from '@node-rs/argon2';
import { MIN_PASSWORD_LENGTH } from '#lib/schemas/auth/sign-in.ts';

/**
 * Argon2id password hashes (SPEC-SIGN-IN S2). @node-rs/argon2 uses Argon2id
 * with OWASP's parameters by default; the hash string carries them, so old
 * hashes keep verifying if the defaults change.
 */
export async function hashPassword(password: string): Promise<string> {
	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`A password must be at least ${MIN_PASSWORD_LENGTH} characters`);
	}
	return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
	return verify(passwordHash, password);
}

/**
 * A real hash of a random password, made once. Checking a password against it
 * when the email is unknown takes as long as a real check, so the reply time
 * does not say whether the account exists.
 */
let decoyHash: Promise<string> | undefined;

export async function verifyDecoy(password: string): Promise<false> {
	decoyHash ??= hash(crypto.randomUUID() + crypto.randomUUID());
	await verify(await decoyHash, password);
	return false;
}
