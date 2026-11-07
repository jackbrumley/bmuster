/**
 * npm run agent:release-local
 *
 * Builds the Rust agent in release mode for this computer and copies it to
 * RELEASES_PATH/<version>/<target>/, so a dev server can offer it on Add
 * machine and to the install scripts (SPEC-INSTALL-OPTIONS M5). The version
 * comes from agent/Cargo.toml. Development only: real releases are built for
 * every target and, later, signed (SPEC-AGENT-UPDATES).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '../src/lib/server/env.ts';
import { AGENT_MANIFEST, agentVersion, binaryName, hostTarget } from './agent-build.ts';

function fail(message: string): never {
	console.error(`agent:release-local: ${message}`);
	process.exit(1);
}

const target =
	hostTarget() ?? fail(`no agent target for this computer (${process.platform}-${process.arch})`);
const binary = binaryName('bmuster-agent', target);
const version = agentVersion();

const build = spawnSync(
	'cargo',
	['build', '--release', '--manifest-path', AGENT_MANIFEST, '-p', 'bmuster-agent'],
	{ stdio: 'inherit' }
);
if (build.status !== 0) {
	fail(`cargo build failed (exit ${String(build.status)})`);
}

const folder = join(env.releasesPath, version, target);
const destination = join(folder, binary);
mkdirSync(folder, { recursive: true });
copyFileSync(join('agent', 'target', 'release', binary), destination);
chmodSync(destination, 0o755);

const sha256 = createHash('sha256').update(readFileSync(destination)).digest('hex');
console.log(`agent:release-local: agent ${version} for ${target}`);
console.log(`  ${destination}`);
console.log(`  SHA-256 ${sha256}`);
