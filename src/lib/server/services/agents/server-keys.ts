import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { serverKeys } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { openSecret, sealSecret } from '../../crypto/secret-box.ts';

/**
 * The server's own Ed25519 key pair, made on first use. Agents learn the
 * public key at enrolment; session tickets will be signed with the private key.
 */
export type ServerKey = { publicKeyBase64: string; privateKey: KeyObject };

export function serverKey(database: AppDatabase, secretsKey: Buffer, now: number): ServerKey {
	const existing = database.select().from(serverKeys).get();
	if (existing !== undefined) {
		const der = openSecret(existing.privateKeyEncrypted, secretsKey);
		return {
			publicKeyBase64: existing.publicKey,
			privateKey: createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
		};
	}
	const pair = generateKeyPairSync('ed25519');
	const publicRaw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
	const privateDer = pair.privateKey.export({ format: 'der', type: 'pkcs8' });
	const publicKeyBase64 = publicRaw.toString('base64');
	database
		.insert(serverKeys)
		.values({
			id: crypto.randomUUID(),
			publicKey: publicKeyBase64,
			privateKeyEncrypted: sealSecret(privateDer, secretsKey),
			createdAt: new Date(now)
		})
		.run();
	return { publicKeyBase64, privateKey: pair.privateKey };
}
