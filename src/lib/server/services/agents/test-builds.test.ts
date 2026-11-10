import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { releaseMessage } from './release-signing.ts';
import { signedReleases } from './releases.ts';
import { fetchTestBuild, TestChannel, testAssetName } from './test-builds.ts';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const KEY = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
const LINUX = 'x86_64-unknown-linux-gnu';
const WINDOWS = 'x86_64-pc-windows-msvc';
const NOW = Date.parse('2026-11-11T12:00:00.000Z');

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
	const made = mkdtempSync(join(tmpdir(), 'bmuster-test-builds-'));
	folders.push(made);
	return join(made, 'agent-test-builds');
}

function signature(version: string, target: string, bytes: Uint8Array): string {
	return sign(null, Buffer.from(releaseMessage(version, target, bytes)), privateKey).toString(
		'base64'
	);
}

type Release = {
	tag: string;
	prerelease: boolean;
	files: Record<string, Uint8Array>;
	sizes: Record<string, number>;
};

/** A release with signed agent builds for `targets`. */
function release(
	tag: string,
	targets: readonly (typeof LINUX | typeof WINDOWS)[],
	prerelease = true
): Release {
	const files: Record<string, Uint8Array> = {};
	for (const target of targets) {
		const bytes = Buffer.from(`agent ${tag} ${target}`);
		files[testAssetName(target)] = bytes;
		files[`${testAssetName(target)}.sig`] = Buffer.from(
			`${signature(tag.slice(1), target, bytes)}\n`
		);
	}
	const sizes = Object.fromEntries(
		Object.entries(files).map(([name, bytes]) => [name, bytes.byteLength])
	);
	return { tag, prerelease, files, sizes };
}

/** GitHub as the fetcher sees it: the release list and each asset by URL. */
function github(releases: readonly Release[]) {
	const asked: string[] = [];
	const get = (url: string, limit: number): Promise<Uint8Array> => {
		asked.push(url);
		if (url.startsWith('https://api.github.com/repos/jackbrumley/bmuster/releases?')) {
			return Promise.resolve(
				Buffer.from(
					JSON.stringify(
						releases.map((item) => ({
							tag_name: item.tag,
							draft: false,
							prerelease: item.prerelease,
							assets: Object.entries(item.sizes).map(([name, size]) => ({ name, size }))
						}))
					)
				)
			);
		}
		for (const item of releases) {
			const prefix = `https://github.com/jackbrumley/bmuster/releases/download/${item.tag}/`;
			const file = url.startsWith(prefix) ? item.files[url.slice(prefix.length)] : undefined;
			if (file !== undefined) {
				if (file.byteLength > limit) return Promise.reject(new Error('over the limit'));
				return Promise.resolve(file);
			}
		}
		return Promise.reject(new Error(`unexpected ${url}`));
	};
	return { get, asked };
}

describe('test builds from GitHub (SPEC-TEST-CHANNEL)', () => {
	it('T6: stores the newest signed pre-release newer than the full build, where the lookup finds it', async () => {
		const path = folder();
		const { get } = github([
			release('v0.4.14', [LINUX], false),
			release('v0.4.15-test.1', [LINUX, WINDOWS]),
			release('v0.4.15-test.2', [LINUX, WINDOWS]),
			release('v0.4.14-test.9', [LINUX])
		]);
		expect(
			await fetchTestBuild({ folder: path, newestFull: '0.4.14', get, publicKey: KEY })
		).toEqual({ kind: 'stored', version: '0.4.15-test.2' });
		expect(readdirSync(path)).toEqual(['0.4.15-test.2']);
		const lookup = signedReleases(join(path, '..', 'none'), path);
		expect(lookup.test(LINUX)?.version).toBe('0.4.15-test.2');
		expect(lookup.test(WINDOWS)?.version).toBe('0.4.15-test.2');
		expect(lookup.test('aarch64-unknown-linux-gnu')).toBeUndefined();
		expect(lookup.full(LINUX)).toBeUndefined();
		expect(readFileSync(join(path, '0.4.15-test.2', WINDOWS, 'bmuster-agent.exe'), 'utf8')).toBe(
			`agent v0.4.15-test.2 ${WINDOWS}`
		);
		// A second fetch keeps it without downloading again.
		const again = github([release('v0.4.15-test.2', [LINUX, WINDOWS])]);
		expect(
			await fetchTestBuild({ folder: path, newestFull: '0.4.14', get: again.get, publicKey: KEY })
		).toEqual({ kind: 'kept', version: '0.4.15-test.2' });
		expect(again.asked).toHaveLength(1);
	});

	it('T6: a test build not newer than the full build is not fetched, and older ones are deleted', async () => {
		const path = folder();
		const { get } = github([release('v0.4.15-test.2', [LINUX])]);
		await fetchTestBuild({ folder: path, newestFull: '0.4.14', get, publicKey: KEY });
		expect(existsSync(join(path, '0.4.15-test.2'))).toBe(true);
		expect(
			await fetchTestBuild({ folder: path, newestFull: '0.4.15', get, publicKey: KEY })
		).toEqual({ kind: 'none' });
		expect(readdirSync(path)).toEqual([]);
		// Full releases and tags that are not plain versions are never test builds.
		const stable = github([
			release('v9.0.0', [LINUX], false),
			release('v9.0.0', [LINUX], true),
			release('nightly-9.0.0-test.1', [LINUX])
		]);
		expect(
			await fetchTestBuild({ folder: path, newestFull: '0.4.15', get: stable.get, publicKey: KEY })
		).toEqual({ kind: 'none' });
	});

	it('T6: a bad signature, a wrong size or no signed build stores nothing', async () => {
		const path = folder();
		const forged = release('v0.4.15-test.1', [LINUX]);
		forged.files[testAssetName(LINUX)] = Buffer.from(`agent v0.4.15-test.1 ${LINUX}!`.slice(1));
		await expect(
			fetchTestBuild({
				folder: path,
				newestFull: '0.4.14',
				get: github([forged]).get,
				publicKey: KEY
			})
		).rejects.toThrow('not signed by the release key');
		const otherKey = generateKeyPairSync('ed25519')
			.publicKey.export({ type: 'spki', format: 'der' })
			.subarray(-32)
			.toString('base64');
		await expect(
			fetchTestBuild({
				folder: path,
				newestFull: '0.4.14',
				get: github([release('v0.4.15-test.1', [LINUX])]).get,
				publicKey: otherKey
			})
		).rejects.toThrow('not signed by the release key');
		const resized = release('v0.4.15-test.1', [LINUX]);
		resized.sizes[testAssetName(LINUX)] = 3;
		await expect(
			fetchTestBuild({
				folder: path,
				newestFull: '0.4.14',
				get: github([resized]).get,
				publicKey: KEY
			})
		).rejects.toThrow();
		const unsigned = release('v0.4.15-test.1', [LINUX]);
		const { [`${testAssetName(LINUX)}.sig`]: _signature, ...withoutSignature } = unsigned.sizes;
		expect(_signature).toBeGreaterThan(0);
		await expect(
			fetchTestBuild({
				folder: path,
				newestFull: '0.4.14',
				get: github([{ ...unsigned, sizes: withoutSignature }]).get,
				publicKey: KEY
			})
		).rejects.toThrow('no signed agent builds');
		expect(existsSync(path) ? readdirSync(path) : []).toEqual([]);
	});

	it('T6: checks hourly while Test has machines and update checks are on, sooner after a failure', async () => {
		let wanted = false;
		let fail = true;
		const channel = new TestChannel(
			() =>
				fail ? Promise.reject(new Error('GitHub is down')) : Promise.resolve({ kind: 'none' }),
			() => wanted
		);
		expect(channel.due(NOW, true)).toBe(false);
		await channel.check(NOW);
		expect(channel.status()).toEqual({ checkedAtIso: null, problem: null });
		wanted = true;
		expect(channel.due(NOW, false)).toBe(false);
		expect(channel.due(NOW, true)).toBe(true);
		await channel.check(NOW);
		expect(channel.status()).toEqual({
			checkedAtIso: new Date(NOW).toISOString(),
			problem: 'GitHub is down'
		});
		expect(channel.due(NOW + 4 * 60 * 1000, true)).toBe(false);
		expect(channel.due(NOW + 5 * 60 * 1000, true)).toBe(true);
		fail = false;
		await channel.check(NOW + 5 * 60 * 1000);
		expect(channel.status().problem).toBeNull();
		expect(channel.due(NOW + 6 * 60 * 1000, true)).toBe(false);
		expect(channel.due(NOW + 65 * 60 * 1000, true)).toBe(true);
	});
});
