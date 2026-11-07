import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { latestRelease, latestSignedRelease, listReleases, releaseFile } from './releases.ts';
import { sha256Hex } from './signing.ts';

function releasesFolder(builds: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), 'bmuster-releases-'));
	for (const [path, content] of Object.entries(builds)) {
		mkdirSync(join(root, path, '..'), { recursive: true });
		writeFileSync(join(root, path), content);
	}
	return root;
}

describe('agent releases (A3)', () => {
	it('serves the newest version that has a build for the target', () => {
		const root = releasesFolder({
			'0.1.0/x86_64-unknown-linux-gnu/bmuster-agent': 'old',
			'0.10.0/x86_64-unknown-linux-gnu/bmuster-agent': 'newest',
			'0.11.0/x86_64-pc-windows-msvc/bmuster-agent.exe': 'windows only'
		});
		expect(latestRelease(root, 'x86_64-unknown-linux-gnu', 'https://s.example')).toEqual({
			version: '0.10.0',
			target: 'x86_64-unknown-linux-gnu',
			size: 6,
			sha256: sha256Hex(Buffer.from('newest')),
			url: 'https://s.example/agent/v1/releases/0.10.0/x86_64-unknown-linux-gnu'
		});
		expect(latestRelease(root, 'aarch64-unknown-linux-gnu', 'https://s.example')).toBeUndefined();
		expect(releaseFile(root, '0.10.0', 'x86_64-unknown-linux-gnu')?.size).toBe(6);
		expect(releaseFile(root, '../0.10.0', 'x86_64-unknown-linux-gnu')).toBeUndefined();
	});

	it('orders development builds before their release and offers only signed builds as updates', () => {
		const linux = 'x86_64-unknown-linux-gnu';
		const root = releasesFolder({
			[`0.1.0-dev.20261107153000/${linux}/bmuster-agent`]: 'dev one',
			[`0.1.0-dev.20261107153000/${linux}/bmuster-agent.sig`]: 'c2lnbmF0dXJl\n',
			[`0.1.0-dev.20261107160000/${linux}/bmuster-agent`]: 'dev two, unsigned',
			[`not-a-version/${linux}/bmuster-agent`]: 'ignored'
		});
		expect(latestRelease(root, linux, 'https://s.example')?.version).toBe(
			'0.1.0-dev.20261107153000'
		);
		expect(latestSignedRelease(root, linux)).toEqual({
			version: '0.1.0-dev.20261107153000',
			size: 7,
			sha256: sha256Hex(Buffer.from('dev one')),
			signature: 'c2lnbmF0dXJl'
		});
		expect(latestSignedRelease(root, 'aarch64-unknown-linux-gnu')).toBeUndefined();
		expect(listReleases(root, [linux])).toEqual([
			{ version: '0.1.0-dev.20261107160000', target: linux, signed: false },
			{ version: '0.1.0-dev.20261107153000', target: linux, signed: true }
		]);
		expect(releaseFile(root, '0.1.0-dev.20261107153000', linux)?.size).toBe(7);
	});

	it('installs the newest signed build, not an older unsigned 0.1.0 that outranks dev builds', () => {
		const linux = 'x86_64-unknown-linux-gnu';
		const root = releasesFolder({
			[`0.1.0/${linux}/bmuster-agent`]: 'stale, unsigned',
			[`0.1.0-dev.20261107100351/${linux}/bmuster-agent`]: 'current',
			[`0.1.0-dev.20261107100351/${linux}/bmuster-agent.sig`]: 'c2lnbmF0dXJl\n'
		});
		expect(latestRelease(root, linux, 'https://s.example')?.version).toBe(
			'0.1.0-dev.20261107100351'
		);
	});
});
