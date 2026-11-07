/**
 * npm run agent:sign -- --target <triple> [--version <version>] [--key-file <pem>] <binary>
 *
 * Signs one agent build for automatic updates (SPEC-AGENT-UPDATES) and writes
 * the signature beside it as `<binary>.sig` (standard base64). The key is a
 * PKCS #8 PEM Ed25519 private key, from --key-file or, when that is left out,
 * from the BMUSTER_RELEASE_SIGNING_KEY environment variable (the release
 * workflow's secret, so the key never touches the runner's disk).
 *
 * The version (default: agent/Cargo.toml's, which release builds carry) and
 * the target are part of what is signed: the agent refuses a build whose
 * signature was made for another version or computer type.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { isAgentTarget } from '../src/lib/domain/machines/agent-release.ts';
import { isAgentVersion } from '../src/lib/domain/machines/agent-version.ts';
import {
	releasePublicKey,
	signRelease
} from '../src/lib/server/services/agents/release-signing.ts';
import { agentVersion } from './agent-build.ts';

function fail(message: string): never {
	console.error(`agent:sign: ${message}`);
	process.exit(1);
}

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		version: { type: 'string' },
		target: { type: 'string' },
		'key-file': { type: 'string' }
	}
});

const [binaryPath] = positionals;
const version = values.version ?? agentVersion();
const target = values.target;
if (binaryPath === undefined || positionals.length !== 1) {
	fail('name exactly one agent binary to sign');
}
if (!isAgentVersion(version)) {
	fail('--version must be a version like 1.2.3 or 1.2.3-dev.20261107153000');
}
if (target === undefined || !isAgentTarget(target)) {
	fail('--target must be an agent target like x86_64-unknown-linux-gnu');
}

const keyFile = values['key-file'];
const keyPem =
	keyFile === undefined
		? (process.env['BMUSTER_RELEASE_SIGNING_KEY'] ?? '')
		: readFileSync(keyFile, 'utf8');
if (keyPem.trim() === '') {
	fail('give --key-file, or set BMUSTER_RELEASE_SIGNING_KEY to the PEM private key');
}

const binary = readFileSync(binaryPath);
const signature = signRelease(keyPem, version, target, binary);
writeFileSync(`${binaryPath}.sig`, `${signature}\n`);
console.log(`agent:sign: signed ${binaryPath} as ${version} for ${target}`);
console.log(`  key ${releasePublicKey(keyPem)}`);
console.log(`  ${binaryPath}.sig`);
