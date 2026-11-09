/**
 * npm run server:update-test
 *
 * The root updater end to end, without root (SPEC-SERVER-UPDATES SU12): the real
 * bmuster-server launcher and updater, built with the `scratch-test` feature and a throwaway
 * release key, the real Node, and small stand-in apps. It installs release A into scratch
 * folders with `install --no-service`, runs it, and then asks the updater, as the console's
 * Update now does, to move to each newer release in a folder of signed releases:
 *
 *   B          healthy: kept, A stays as the previous release
 *   C          signed by another key: refused, nothing changes
 *   D          never ready, declares B compatible: rolled back to B
 *   E          never ready, declares nothing: stopped, with a database copy
 *
 * The `scratch-test` build reads its releases from a folder and drives the service with a script
 * instead of systemd; the signature, version, size, hash and archive checks are the release
 * build's own. Linux only (the release workflow runs it before publishing).
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AGENT_MANIFEST, hostTarget } from './agent-build.ts';

const DOMAIN = Buffer.from('BMUSTER-SERVER-UPDATE-1\n');

function fail(message: string): never {
	console.error(`server:update-test: ${message}`);
	process.exit(1);
}

function check(condition: boolean, message: string): void {
	if (!condition) fail(message);
	console.log(`  ok  ${message}`);
}

const target = hostTarget();
if (process.platform !== 'linux' || target === undefined) fail('this test runs on Linux');

const scratch = mkdtempSync(join(tmpdir(), 'bmuster-update-test-'));
// However the test ends: the stand-in server stopped, the scratch folders gone.
process.on('exit', () => {
	const pidfile = join(scratch, 'launcher.pid');
	if (existsSync(pidfile)) spawnSync('kill', [readFileSync(pidfile, 'utf8').trim()]);
	rmSync(scratch, { recursive: true, force: true });
});
const prefix = join(scratch, 'opt');
const data = join(scratch, 'data');
const source = join(scratch, 'source');
const releaseKey = generateKeyPairSync('ed25519');
const otherKey = generateKeyPairSync('ed25519');

function rawPublicKey(key: KeyObject): string {
	const der = key.export({ format: 'der', type: 'spki' });
	return der.subarray(der.byteLength - 32).toString('base64');
}

// The launcher and updater, trusting the throwaway key besides the project's.
const targetDir = resolve('agent', 'target', 'scratch-update-test');
const built = spawnSync(
	'cargo',
	[
		'build',
		'--manifest-path',
		AGENT_MANIFEST,
		'-p',
		'bmuster-server',
		'--features',
		'scratch-test',
		'--target-dir',
		targetDir
	],
	{
		stdio: 'inherit',
		env: { ...process.env, BMUSTER_EXTRA_RELEASE_KEY: rawPublicKey(releaseKey.publicKey) }
	}
);
if (built.status !== 0) fail('cargo build failed');
const launcherBinary = join(targetDir, 'debug', 'bmuster-server');

/** A stand-in app: reports ready with its launcher's nonce, or (broken) exits at once. */
function appSource(version: string, broken: boolean): string {
	return broken
		? `process.exit(1);\n`
		: `const { renameSync, writeFileSync } = require('node:fs');
const path = require('node:path').join(process.env.BMUSTER_UPDATE_DATA, 'ready.json');
writeFileSync(path + '.new', JSON.stringify({ nonce: process.env.BMUSTER_READINESS_NONCE, version: ${JSON.stringify(version)} }));
renameSync(path + '.new', path);
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`;
}

/** An unpacked bundle of `version`, as release-server.ts lays one out. */
function bundle(version: string, broken: boolean): string {
	const dir = join(scratch, 'bundles', version);
	mkdirSync(join(dir, 'node', 'bin'), { recursive: true });
	mkdirSync(join(dir, 'app'), { recursive: true });
	mkdirSync(join(dir, 'releases', version), { recursive: true });
	copyFileSync(launcherBinary, join(dir, 'bmuster-server'));
	chmodSync(join(dir, 'bmuster-server'), 0o755);
	copyFileSync(process.execPath, join(dir, 'node', 'bin', 'node'));
	chmodSync(join(dir, 'node', 'bin', 'node'), 0o755);
	writeFileSync(join(dir, 'app', 'server.js'), appSource(version, broken));
	writeFileSync(join(dir, 'app', 'package.json'), JSON.stringify({ version }));
	writeFileSync(join(dir, 'VERSION'), `${version}\n`);
	writeFileSync(join(dir, 'LICENSE'), 'AGPL-3.0-only\n');
	return dir;
}

/** Publishes a bundle in the release folder with its signed manifest. */
function publish(
	version: string,
	options: { broken: boolean; rollbackFrom: string[]; signer: KeyObject }
): void {
	const dir = bundle(version, options.broken);
	const folder = join(source, `v${version}`);
	mkdirSync(folder, { recursive: true });
	const archive = join(folder, `bmuster-app-${target}.tar.gz`);
	const tar = spawnSync('tar', [
		'-czf',
		archive,
		'-C',
		dir,
		'bmuster-server',
		'node',
		'app',
		'releases',
		'VERSION',
		'LICENSE'
	]);
	if (tar.status !== 0) fail(`tar failed for ${version}`);
	const bytes = readFileSync(archive);
	const payload = Buffer.from(
		JSON.stringify({
			schemaVersion: 1,
			version,
			target,
			archive: `bmuster-app-${target}.tar.gz`,
			bytes: bytes.byteLength,
			sha256: createHash('sha256').update(bytes).digest('hex'),
			minimumLauncher: '0.90.0',
			nodeMajor: 26,
			rollbackFrom: options.rollbackFrom
		})
	);
	const signature = sign(null, Buffer.concat([DOMAIN, payload]), options.signer);
	writeFileSync(
		join(folder, `bmuster-app-${target}.json`),
		JSON.stringify({ payload: payload.toString('base64'), signature: signature.toString('base64') })
	);
	writeFileSync(join(source, 'latest'), `${version}\n`);
}

// The service script the scratch-test build calls instead of systemd.
const service = join(scratch, 'service.sh');
writeFileSync(
	service,
	`#!/bin/sh
pidfile="${scratch}/launcher.pid"
case "$1" in
start)
	"${prefix}/current/bmuster-server" run --data-dir "${data}" >>"${scratch}/run.log" 2>&1 &
	echo $! >"$pidfile"
	;;
stop)
	[ -f "$pidfile" ] || exit 0
	pid="$(cat "$pidfile")"
	kill "$pid" 2>/dev/null || true
	while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
	rm -f "$pidfile"
	;;
esac
`
);
chmodSync(service, 0o755);
const updaterEnv = {
	...process.env,
	BMUSTER_UPDATE_TEST_SERVICE: service,
	BMUSTER_UPDATE_TEST_SOURCE: source,
	BMUSTER_UPDATE_TEST_HEALTH_SECONDS: '10'
};

function update(): SpawnSyncReturns<string> {
	writeFileSync(join(data, 'update-requested'), '');
	return spawnSync(
		join(prefix, 'current', 'bmuster-server'),
		['update', '--prefix', prefix, '--data-dir', data],
		{ env: updaterEnv, encoding: 'utf8' }
	);
}

function current(): string {
	return readlinkSync(join(prefix, 'current'));
}

function status(): { phase: string; message: string } {
	const parsed: unknown = JSON.parse(readFileSync(join(data, 'update-status.json'), 'utf8'));
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('phase' in parsed) ||
		typeof parsed.phase !== 'string' ||
		!('message' in parsed) ||
		typeof parsed.message !== 'string'
	)
		fail('update-status.json is not understood');
	return { phase: parsed.phase, message: parsed.message };
}

function readyVersion(): string {
	for (let tries = 0; tries < 50; tries += 1) {
		if (existsSync(join(data, 'ready.json'))) {
			const ready: unknown = JSON.parse(readFileSync(join(data, 'ready.json'), 'utf8'));
			if (typeof ready === 'object' && ready !== null && 'version' in ready)
				return String(ready.version);
		}
		spawnSync('sleep', ['0.2']);
	}
	return 'none';
}

function running(): boolean {
	const pidfile = join(scratch, 'launcher.pid');
	if (!existsSync(pidfile)) return false;
	return spawnSync('kill', ['-0', readFileSync(pidfile, 'utf8').trim()]).status === 0;
}

console.log(`server:update-test: in ${scratch}`);
const a = bundle('0.90.0', false);
const installed = spawnSync(
	join(a, 'bmuster-server'),
	['install', '--no-service', '--prefix', prefix, '--data-dir', data, '--port', '47699'],
	{ encoding: 'utf8' }
);
if (installed.status !== 0) fail(`install failed: ${installed.stderr}`);
writeFileSync(join(data, 'bmuster.db'), 'the database');
check(current() === 'releases/0.90.0', 'install made releases/0.90.0 and current');
spawnSync(service, ['start']);
check(readyVersion() === '0.90.0', 'A runs and reports ready');

let result = spawnSync(
	join(prefix, 'current', 'bmuster-server'),
	['update', '--prefix', prefix, '--data-dir', data],
	{ env: updaterEnv, encoding: 'utf8' }
);
check(result.status === 0 && result.stdout.includes('NothingToDo'), 'no flag: nothing to do');

publish('0.90.1', { broken: false, rollbackFrom: ['0.90.0'], signer: releaseKey.privateKey });
result = update();
check(result.status === 0, `A to B: the updater succeeded ${result.stderr}`);
check(current() === 'releases/0.90.1', 'A to B: current is B');
check(status().phase === 'healthy', 'A to B: status healthy');
check(readyVersion() === '0.90.1' && running(), 'A to B: B runs');
check(existsSync(join(prefix, 'releases', '0.90.0')), 'A to B: A kept as the previous release');
check(
	readFileSync(join(data, 'backups', 'pre-update-0.90.0-to-0.90.1.db'), 'utf8') === 'the database',
	'A to B: the database was copied first'
);

publish('0.90.2', { broken: false, rollbackFrom: ['0.90.1'], signer: otherKey.privateKey });
result = update();
check(result.status !== 0 && current() === 'releases/0.90.1', 'another key: refused');
check(status().message.includes('not from a trusted release key'), 'another key: says why');
check(running(), 'another key: B still runs');

publish('0.90.3', { broken: true, rollbackFrom: ['0.90.1'], signer: releaseKey.privateKey });
result = update();
check(result.status === 0, 'broken D (compatible): the updater rolled back');
check(current() === 'releases/0.90.1', 'broken D (compatible): rolled back to B');
check(status().phase === 'rolled-back', 'broken D (compatible): status rolled-back');
check(readyVersion() === '0.90.1' && running(), 'broken D (compatible): B runs again');

publish('0.90.4', { broken: true, rollbackFrom: [], signer: releaseKey.privateKey });
result = update();
check(result.status !== 0, 'broken E (incompatible): the updater reports failure');
check(current() === 'releases/0.90.4', 'broken E (incompatible): not rolled back');
check(!running(), 'broken E (incompatible): the server is stopped');
check(
	status().phase === 'failed' && status().message.includes('pre-update-0.90.1-to-0.90.4.db'),
	'broken E (incompatible): instructions name the database copy'
);
check(
	readFileSync(join(data, 'bmuster.db'), 'utf8') === 'the database',
	'the database was never replaced'
);

// A power cut part-way through a rollback: boot-time recovery finishes it.
writeFileSync(
	join(prefix, 'update-switch.json'),
	JSON.stringify({
		from: '0.90.1',
		to: '0.90.4',
		step: 'rolling-back',
		nonce: 'e'.repeat(64),
		rollbackCompatible: true
	})
);
result = spawnSync(
	join(prefix, 'current', 'bmuster-server'),
	['update', '--recover', '--prefix', prefix, '--data-dir', data],
	{ env: updaterEnv, encoding: 'utf8' }
);
check(result.status === 0 && result.stdout.includes('Recovered'), 'recover: ran at boot');
check(current() === 'releases/0.90.1', 'recover: the rollback was finished');
check(!existsSync(join(prefix, 'update-switch.json')), 'recover: the switch record is gone');
check(!running(), 'recover: the service was left for boot to start');
console.log('server:update-test: passed');
