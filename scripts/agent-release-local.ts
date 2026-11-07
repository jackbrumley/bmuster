/**
 * npm run agent:release-local [-- --key-file <pem>]
 *
 * Builds the Rust agent in release mode for this computer, signs it, and
 * copies it to RELEASES_PATH/<version>/<target>/, so a dev server can offer it
 * on Add machine, to the install scripts (SPEC-INSTALL-OPTIONS M5) and as an
 * automatic update (SPEC-AGENT-UPDATES).
 *
 * Every build gets its own version, `<Cargo version>-dev.<UTC time>` (for
 * example 0.1.0-dev.20261107153000), so agents see that a newer build exists
 * and nobody installs a stale build by mistake. It sorts before the release
 * of the same number.
 *
 * Signing uses a development key, made on first use, in
 * ~/.config/bmuster-dev/release-dev-key.pem (or --key-file). Its public half
 * is built into this build only (BMUSTER_EXTRA_RELEASE_KEY), so development
 * agents trust development builds and release agents never do.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { env } from '../src/lib/server/env.ts';
import {
	newReleaseKey,
	releasePublicKey,
	signRelease
} from '../src/lib/server/services/agents/release-signing.ts';
import { AGENT_MANIFEST, agentVersion, binaryName, hostTarget } from './agent-build.ts';

const { values } = parseArgs({
	options: {
		'key-file': {
			type: 'string',
			default: join(homedir(), '.config', 'bmuster-dev', 'release-dev-key.pem')
		}
	}
});

function fail(message: string): never {
	console.error(`agent:release-local: ${message}`);
	process.exit(1);
}

/** `20261107153000`: the build's UTC time, to the second. */
function buildStamp(now: Date): string {
	return now.toISOString().replace(/\D/g, '').slice(0, 14);
}

/** The development signing key, made the first time. */
function devKey(path: string): string {
	if (!existsSync(path)) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, newReleaseKey(), { mode: 0o600, flag: 'wx' });
		console.log(`agent:release-local: made a development signing key in ${path}`);
	}
	return readFileSync(path, 'utf8');
}

const target =
	hostTarget() ?? fail(`no agent target for this computer (${process.platform}-${process.arch})`);
const binary = binaryName('bmuster-agent', target);
const version = `${agentVersion()}-dev.${buildStamp(new Date())}`;
const keyPem = devKey(values['key-file']);

const build = spawnSync(
	'cargo',
	['build', '--release', '--manifest-path', AGENT_MANIFEST, '-p', 'bmuster-agent'],
	{
		stdio: 'inherit',
		env: {
			...process.env,
			BMUSTER_VERSION: version,
			BMUSTER_EXTRA_RELEASE_KEY: releasePublicKey(keyPem)
		}
	}
);
if (build.status !== 0) {
	fail(`cargo build failed (exit ${String(build.status)})`);
}

const targetDir = process.env['CARGO_TARGET_DIR'] ?? join('agent', 'target');
const folder = join(env.releasesPath, version, target);
const destination = join(folder, binary);
mkdirSync(folder, { recursive: true });
copyFileSync(join(targetDir, 'release', binary), destination);
chmodSync(destination, 0o755);

const bytes = readFileSync(destination);
writeFileSync(`${destination}.sig`, `${signRelease(keyPem, version, target, bytes)}\n`);
const sha256 = createHash('sha256').update(bytes).digest('hex');
console.log(`agent:release-local: agent ${version} for ${target}, signed with the development key`);
console.log(`  ${destination}`);
console.log(`  SHA-256 ${sha256}`);
