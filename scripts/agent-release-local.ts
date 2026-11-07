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

const MANIFEST = 'agent/Cargo.toml';

function fail(message: string): never {
	console.error(`agent:release-local: ${message}`);
	process.exit(1);
}

/** This computer's Rust target, as the server names its builds. */
function hostTarget(): { target: string; binary: string } {
	const key = `${process.platform}-${process.arch}`;
	switch (key) {
		case 'linux-x64':
			return { target: 'x86_64-unknown-linux-gnu', binary: 'bmuster-agent' };
		case 'linux-arm64':
			return { target: 'aarch64-unknown-linux-gnu', binary: 'bmuster-agent' };
		case 'win32-x64':
			return { target: 'x86_64-pc-windows-msvc', binary: 'bmuster-agent.exe' };
		default:
			return fail(`no agent target for this computer (${key})`);
	}
}

/** `version = "x.y.z"` from [workspace.package], else from [package]. */
function agentVersion(): string {
	const text = readFileSync(MANIFEST, 'utf8');
	for (const section of ['workspace.package', 'package']) {
		const body = text.split(`[${section}]`)[1]?.split(/^\[/m)[0];
		const version = body === undefined ? undefined : /^version\s*=\s*"([^"]+)"/m.exec(body)?.[1];
		if (version !== undefined) {
			if (!/^\d+\.\d+\.\d+$/.test(version)) {
				fail(`${MANIFEST} has version ${version}; the server serves only x.y.z versions`);
			}
			return version;
		}
	}
	return fail(`${MANIFEST} has no version`);
}

const { target, binary } = hostTarget();
const version = agentVersion();

const build = spawnSync('cargo', ['build', '--release', '--manifest-path', MANIFEST], {
	stdio: 'inherit'
});
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
