import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAuthorization, requestMessage, verifySignature } from './signing.ts';

// SPEC-ENROLMENT A11: the shared vectors in agent/crates/protocol, byte for byte.
type Vectors = {
	seedHex: string;
	publicKeyBase64: string;
	machineId: string;
	requests: {
		method: string;
		path: string;
		timestampMs: number;
		body: string;
		messageUtf8: string;
		signatureBase64: string;
		authorization: string;
	}[];
};

const vectors = JSON.parse(
	readFileSync('agent/crates/protocol/tests/vectors.json', 'utf8')
) as Vectors;

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const privateKey = createPrivateKey({
	key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(vectors.seedHex, 'hex')]),
	format: 'der',
	type: 'pkcs8'
});

describe('agent request signing (A11)', () => {
	for (const vector of vectors.requests) {
		it(`matches the shared vector for ${vector.method} ${vector.path}`, () => {
			const message = requestMessage(
				vector.method,
				vector.path,
				vector.timestampMs,
				Buffer.from(vector.body, 'utf8')
			);
			expect(message.toString('utf8')).toBe(vector.messageUtf8);
			expect(sign(null, message, privateKey).toString('base64')).toBe(vector.signatureBase64);
			expect(
				verifySignature(
					vectors.publicKeyBase64,
					message,
					Buffer.from(vector.signatureBase64, 'base64')
				)
			).toBe(true);
			expect(parseAuthorization(vector.authorization)).toEqual({
				machineId: vectors.machineId,
				timestampMs: vector.timestampMs,
				signature: Buffer.from(vector.signatureBase64, 'base64')
			});
		});
	}

	it('rejects malformed authorization headers', () => {
		expect(parseAuthorization(null)).toBeUndefined();
		expect(parseAuthorization('Bearer abc')).toBeUndefined();
		expect(parseAuthorization(`BMuster ${vectors.machineId}:12:short`)).toBeUndefined();
	});
});
