/**
 * docs/install.sh checks the release manifest's Ed25519 signature with the release key it prints,
 * then the archive's size and SHA-256, before it runs anything from the archive
 * (SPEC-SERVER-UPDATES SU11). The script has no way to trust another key; these tests run a copy
 * with only the printed key swapped for a test key.
 */
import { spawnSync } from 'node:child_process';
import {
	createHash,
	createPublicKey,
	generateKeyPairSync,
	sign,
	type KeyObject
} from 'node:crypto';
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = readFileSync('docs/install.sh', 'utf8');
const DOMAIN = Buffer.from('BMUSTER-SERVER-UPDATE-1\n');
const TARGET = process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
const ARCHIVE = `bmuster-app-${TARGET}.tar.gz`;
const MANIFEST = `bmuster-app-${TARGET}.json`;
const PRINTED_KEY =
	/RELEASE_KEY_PEM="(-----BEGIN PUBLIC KEY-----\n[A-Za-z0-9+/=]+\n-----END PUBLIC KEY-----)"/;
const linux = process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch);

const folders: string[] = [];
afterEach(() => {
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function printedKey(): string {
	const match = PRINTED_KEY.exec(SCRIPT);
	if (match?.[1] === undefined) throw new Error('install.sh prints no release key');
	return match[1];
}

function rawKey(pem: string): string {
	const der = createPublicKey(pem).export({ format: 'der', type: 'spki' });
	return der.subarray(der.byteLength - 32).toString('base64');
}

type Rig = { dir: string; archive: string; record: string; script: string };

/** A release folder with a fake bundle whose launcher records its arguments, signed by `signer`. */
function rig(options: { signer: KeyObject; trusted: KeyObject; tamper: boolean }): Rig {
	const dir = mkdtempSync(join(tmpdir(), 'bmuster-install-sh-'));
	folders.push(dir);
	const bundle = join(dir, 'bundle');
	mkdirSync(bundle);
	const record = join(dir, 'launcher-ran');
	writeFileSync(join(bundle, 'bmuster-server'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${record}"\n`);
	chmodSync(join(bundle, 'bmuster-server'), 0o755);
	writeFileSync(join(bundle, 'VERSION'), '0.4.1\n');
	const release = join(dir, 'release');
	mkdirSync(release);
	const archive = join(release, ARCHIVE);
	const tar = spawnSync('tar', ['-czf', archive, '-C', bundle, 'bmuster-server', 'VERSION']);
	expect(tar.status).toBe(0);
	const bytes = readFileSync(archive);
	const payload = Buffer.from(
		JSON.stringify({
			schemaVersion: 1,
			version: '0.4.1',
			target: TARGET,
			archive: ARCHIVE,
			bytes: bytes.byteLength,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			minimumLauncher: '0.4.0',
			nodeMajor: 26,
			rollbackFrom: ['0.4.0']
		})
	);
	const signature = sign(null, Buffer.concat([DOMAIN, payload]), options.signer);
	writeFileSync(
		join(release, MANIFEST),
		`${JSON.stringify({ payload: payload.toString('base64'), signature: signature.toString('base64') })}\n`
	);
	if (options.tamper) {
		const changed = Buffer.from(bytes);
		changed[changed.byteLength - 1] = (changed[changed.byteLength - 1] ?? 0) ^ 1;
		writeFileSync(archive, changed);
	}
	const der = options.trusted.export({ format: 'der', type: 'spki' });
	const trustedPem = `-----BEGIN PUBLIC KEY-----\n${der.toString('base64')}\n-----END PUBLIC KEY-----`;
	const script = join(dir, 'install.sh');
	writeFileSync(script, SCRIPT.replace(printedKey(), trustedPem));
	return { dir, archive, record, script };
}

function install(rig: Rig, archive: string = rig.archive) {
	return spawnSync(
		'sh',
		[
			rig.script,
			'--archive',
			archive,
			'--no-service',
			'--prefix',
			join(rig.dir, 'opt'),
			'--data-dir',
			join(rig.dir, 'data')
		],
		{ encoding: 'utf8' }
	);
}

describe('install.sh verifies the signed manifest before installing (SPEC-SERVER-UPDATES SU11)', () => {
	it('prints the same release key the updater and agents trust', () => {
		const projectKey = readFileSync('agent/crates/agent/release-key.pub', 'utf8').trim();
		expect(rawKey(printedKey())).toBe(projectKey);
		expect(SCRIPT).not.toMatch(/SHA256SUMS/);
	});

	it.runIf(linux)('installs an archive whose manifest the release key signed', () => {
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		const setup = rig({ signer: privateKey, trusted: publicKey, tamper: false });
		const result = install(setup);
		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('Signature verified: BMuster 0.4.1');
		expect(readFileSync(setup.record, 'utf8').split('\n')).toEqual([
			'install',
			'--prefix',
			join(setup.dir, 'opt'),
			'--data-dir',
			join(setup.dir, 'data'),
			'--no-service',
			''
		]);
	});

	it.runIf(linux)('refuses a manifest signed by another key, and runs nothing', () => {
		const trusted = generateKeyPairSync('ed25519');
		const other = generateKeyPairSync('ed25519');
		const setup = rig({ signer: other.privateKey, trusted: trusted.publicKey, tamper: false });
		const result = install(setup);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('is not signed by the BMuster release key');
		expect(existsSync(setup.record)).toBe(false);
	});

	it.runIf(linux)('the real script refuses a release signed by any key but the project one', () => {
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		const setup = rig({ signer: privateKey, trusted: publicKey, tamper: false });
		writeFileSync(setup.script, SCRIPT);
		const result = install(setup);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('is not signed by the BMuster release key');
		expect(existsSync(setup.record)).toBe(false);
	});

	it.runIf(linux)('refuses an archive that differs from its signed hash', () => {
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		const setup = rig({ signer: privateKey, trusted: publicKey, tamper: true });
		const result = install(setup);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('does not match its signed SHA-256');
		expect(existsSync(setup.record)).toBe(false);
	});

	it.runIf(linux)('refuses an archive with no signed manifest beside it', () => {
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		const setup = rig({ signer: privateKey, trusted: publicKey, tamper: false });
		rmSync(join(setup.dir, 'release', MANIFEST));
		const result = install(setup);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain('there is no signed manifest');
		expect(existsSync(setup.record)).toBe(false);
	});
});
