/**
 * npm run agent:release-key -- --out <file>
 *
 * Makes the project's release key pair (SPEC-AGENT-UPDATES), once. The public
 * key goes into agent/crates/agent/release-key.pub, which every agent build
 * trusts. The private key is written to --out (mode 0600, never inside this
 * repository) for you to store as the BMUSTER_RELEASE_SIGNING_KEY secret of
 * the release workflow, and then to keep offline or delete.
 *
 * Replacing the key means agents built with the old public key refuse every
 * build signed with the new one until they are reinstalled; do it only if
 * the private key is lost or leaked.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
	newReleaseKey,
	releasePublicKey
} from '../src/lib/server/services/agents/release-signing.ts';

const PUBLIC_KEY_FILE = 'agent/crates/agent/release-key.pub';

function fail(message: string): never {
	console.error(`agent:release-key: ${message}`);
	process.exit(1);
}

const { values } = parseArgs({ options: { out: { type: 'string' } } });
const out = values.out;
if (out === undefined) {
	fail('give --out <file> for the private key, outside this repository');
}
if (!relative(process.cwd(), resolve(out)).startsWith('..')) {
	fail('the private key must not be written inside this repository');
}
if (existsSync(out)) {
	fail(`${out} already exists; move it away first`);
}

const privateKeyPem = newReleaseKey();
mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
writeFileSync(out, privateKeyPem, { mode: 0o600, flag: 'wx' });
writeFileSync(PUBLIC_KEY_FILE, `${releasePublicKey(privateKeyPem)}\n`);
console.log(`agent:release-key: private key ${out}`);
console.log(`  public key ${PUBLIC_KEY_FILE}: ${releasePublicKey(privateKeyPem)}`);
console.log('  Store it as the release secret, then remove it from this computer:');
console.log(`  gh secret set BMUSTER_RELEASE_SIGNING_KEY < ${out}`);
