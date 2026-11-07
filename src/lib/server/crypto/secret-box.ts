import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for secrets at rest. Output: `v1.<iv>.<tag>.<ciphertext>`, each
 * part base64url. A fresh 12-byte IV every time.
 */
export function sealSecret(plaintext: Buffer, key: Buffer): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return ['v1', iv, tag, ciphertext]
		.map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
		.join('.');
}

export function openSecret(sealed: string, key: Buffer): Buffer {
	const [version, iv, tag, ciphertext] = sealed.split('.');
	if (version !== 'v1' || iv === undefined || tag === undefined || ciphertext === undefined) {
		throw new Error('Sealed secret has an unknown format');
	}
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
	decipher.setAuthTag(Buffer.from(tag, 'base64url'));
	return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]);
}
