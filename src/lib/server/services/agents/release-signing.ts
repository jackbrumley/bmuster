import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { sha256Hex } from './signing.ts';

/**
 * Signing agent builds (SPEC-AGENT-UPDATES). The server never holds a release
 * key and never signs: `scripts/agent-sign.ts` (the release workflow and
 * `npm run agent:release-local`) does. The agent verifies the same message
 * with the keys built into it (agent/crates/protocol/src/updates.rs);
 * agent/crates/protocol/tests/release-vectors.json proves both sides agree.
 */

/** First line of every signed release message; the agent's RELEASE_SIGNING_DOMAIN. */
const RELEASE_SIGNING_DOMAIN = 'BMUSTER-RELEASE-1';

/** The exact text a release key signs for one agent build. */
export function releaseMessage(version: string, target: string, binary: Uint8Array): string {
	return [RELEASE_SIGNING_DOMAIN, version, target, binary.byteLength, sha256Hex(binary)].join('\n');
}

/** Standard base64 Ed25519 signature of one build, with a PKCS #8 PEM private key. */
export function signRelease(
	privateKeyPem: string,
	version: string,
	target: string,
	binary: Uint8Array
): string {
	const key = createPrivateKey(privateKeyPem);
	if (key.asymmetricKeyType !== 'ed25519') {
		throw new Error('The release signing key must be an Ed25519 key');
	}
	return sign(null, Buffer.from(releaseMessage(version, target, binary)), key).toString('base64');
}

/** The raw 32-byte public key, standard base64: what the agent's release-key.pub holds. */
export function releasePublicKey(privateKeyPem: string): string {
	const spki = createPublicKey(createPrivateKey(privateKeyPem)).export({
		format: 'der',
		type: 'spki'
	});
	// An Ed25519 SubjectPublicKeyInfo is a fixed 12-byte header and the 32-byte key.
	return spki.subarray(spki.byteLength - 32).toString('base64');
}

/** A new release key pair: the private key as PKCS #8 PEM. */
export function newReleaseKey(): string {
	return generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
}
