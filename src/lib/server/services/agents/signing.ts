import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

/**
 * Agent request signing (SPEC-ENROLMENT 6 and 6.1). Must match
 * agent/crates/protocol byte for byte; tests/vectors.json proves it.
 */

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function requestMessage(
	method: string,
	path: string,
	timestampMs: number,
	body: Uint8Array
): Buffer {
	const bodyHash = createHash('sha256').update(body).digest('hex');
	return Buffer.from(`BMUSTER-REQ-1\n${method}\n${path}\n${timestampMs}\n${bodyHash}`, 'utf8');
}

export type ParsedAuthorization = {
	machineId: string;
	timestampMs: number;
	signature: Buffer;
};

/** `BMuster <machineId>:<timestampMs>:<base64 signature>`, or undefined when malformed. */
export function parseAuthorization(header: string | null): ParsedAuthorization | undefined {
	const match =
		header === null
			? null
			: /^BMuster ([0-9a-f-]{36}):(\d{1,16}):([A-Za-z0-9+/]{86}==)$/.exec(header);
	if (match === null) {
		return undefined;
	}
	const [, machineId, timestamp, signature] = match;
	if (machineId === undefined || timestamp === undefined || signature === undefined) {
		return undefined;
	}
	return { machineId, timestampMs: Number(timestamp), signature: Buffer.from(signature, 'base64') };
}

function publicKeyFromBase64(publicKeyBase64: string): KeyObject {
	const raw = Buffer.from(publicKeyBase64, 'base64');
	if (raw.length !== 32) {
		throw new Error('An Ed25519 public key is 32 bytes');
	}
	return createPublicKey({
		key: Buffer.concat([SPKI_ED25519_PREFIX, raw]),
		format: 'der',
		type: 'spki'
	});
}

export function verifySignature(
	publicKeyBase64: string,
	message: Buffer,
	signature: Buffer
): boolean {
	return verify(null, message, publicKeyFromBase64(publicKeyBase64), signature);
}

export function sha256Hex(data: Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}
