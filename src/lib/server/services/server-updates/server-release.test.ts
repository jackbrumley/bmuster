import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	RELEASE_PUBLIC_KEY,
	SERVER_SIGNING_DOMAIN,
	verifyManifest,
	newestRelease
} from './release.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const key = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const manifest = {
	schemaVersion: 1,
	version: '0.3.1',
	target: 'x86_64-unknown-linux-gnu',
	archive: 'bmuster-app-x86_64-unknown-linux-gnu.tar.gz',
	bytes: 100,
	sha256: 'a'.repeat(64),
	minimumLauncher: '0.3.0',
	nodeMajor: 26,
	rollbackFrom: ['0.3.0']
};
function signed() {
	const payload = Buffer.from(JSON.stringify(manifest));
	return Buffer.from(
		JSON.stringify({
			payload: payload.toString('base64'),
			signature: sign(
				null,
				Buffer.concat([Buffer.from(SERVER_SIGNING_DOMAIN), payload]),
				privateKey
			).toString('base64')
		})
	);
}

describe('SU2 signed stable server releases', () => {
	it('uses the same public key as the Rust agents and launcher', () => {
		expect(RELEASE_PUBLIC_KEY).toBe(
			readFileSync('agent/crates/agent/release-key.pub', 'utf8').trim()
		);
	});
	it('rejects unsigned and tampered manifests', () => {
		expect(verifyManifest(signed(), key).version).toBe('0.3.1');
		expect(() => verifyManifest(signed(), RELEASE_PUBLIC_KEY)).toThrow('signature');
		const changed = JSON.parse(signed().toString('utf8')) as { payload: string; signature: string };
		changed.payload = Buffer.from(JSON.stringify({ ...manifest, bytes: 101 })).toString('base64');
		expect(() => verifyManifest(Buffer.from(JSON.stringify(changed)), key)).toThrow('signature');
	});
	it('ignores older versions and validates platform assets', async () => {
		const metadata = Buffer.from(
			JSON.stringify({
				tag_name: 'v0.3.1',
				draft: false,
				prerelease: false,
				body: 'Changes',
				published_at: '2026-11-08T00:00:00Z',
				assets: [
					{ name: `bmuster-app-${manifest.target}.json`, size: signed().length },
					{ name: manifest.archive, size: 100 }
				]
			})
		);
		const get = (url: string) =>
			Promise.resolve(url.includes('api.github.com') ? metadata : signed());
		expect(await newestRelease('0.3.1', manifest.target, get, key)).toBeNull();
		expect((await newestRelease('0.3.0', manifest.target, get, key))?.version).toBe('0.3.1');
		await expect(newestRelease('0.3.0', 'aarch64-unknown-linux-gnu', get, key)).rejects.toThrow(
			'manifest'
		);
	});
});
