import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { newReleaseKey, releaseMessage, releasePublicKey, signRelease } from './release-signing.ts';

const vectorSchema = z.object({
	seedHex: z.string(),
	publicKeyBase64: z.string(),
	version: z.string(),
	target: z.string(),
	binaryUtf8: z.string(),
	messageUtf8: z.string(),
	signatureBase64: z.string()
});

const vector = vectorSchema.parse(
	JSON.parse(readFileSync('agent/crates/protocol/tests/release-vectors.json', 'utf8'))
);

/** The vector's seed as the PKCS #8 PEM the signing script reads. */
function vectorKeyPem(): string {
	const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
	return createPrivateKey({
		key: Buffer.concat([prefix, Buffer.from(vector.seedHex, 'hex')]),
		format: 'der',
		type: 'pkcs8'
	}).export({ format: 'pem', type: 'pkcs8' });
}

describe('release signing (SPEC-AGENT-UPDATES)', () => {
	it('reproduces the shared vector the agent verifies', () => {
		const binary = Buffer.from(vector.binaryUtf8);
		expect(releaseMessage(vector.version, vector.target, binary)).toBe(vector.messageUtf8);
		const pem = vectorKeyPem();
		expect(signRelease(pem, vector.version, vector.target, binary)).toBe(vector.signatureBase64);
		expect(releasePublicKey(pem)).toBe(vector.publicKeyBase64);
	});

	it('makes new Ed25519 keys and refuses other kinds', () => {
		const pem = newReleaseKey();
		expect(Buffer.from(releasePublicKey(pem), 'base64')).toHaveLength(32);
		const other = generateKeyPairSync('x25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
		expect(() => signRelease(other, '1.0.0', 't', Buffer.from(''))).toThrow('Ed25519');
	});
});
