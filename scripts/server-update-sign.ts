/**
 * Signs the whole-install bundle release-server.ts made (bmuster-app-<target>.tar.gz) with the
 * offline release key: the manifest the root updater, install.sh and installed v0.3.x servers read
 * (SPEC-SERVER-UPDATES). Every release needs its entry in docs/server-update-compatibility.json:
 * `minimumLauncher` is the oldest installed version whose updater may install it by itself, and
 * `rollbackFrom` lists the versions tested to run on the database it leaves (automatic rollback).
 */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { compareAgentVersions } from '../src/lib/domain/machines/agent-version.ts';
import { stableVersionSchema } from '../src/lib/schemas/releases/server-updates.ts';

const DOMAIN = Buffer.from('BMUSTER-SERVER-UPDATE-1\n');
/** The last release whose bundle was the app alone (SPEC-SERVER-UPDATES, version 1). */
const LAST_APP_ONLY_RELEASE = '0.3.3';
const PUBLIC_KEY = readFileSync('agent/crates/agent/release-key.pub', 'utf8').trim();
const Compatibility = z.record(
	z.string(),
	z.strictObject({
		minimumLauncher: stableVersionSchema,
		rollbackFrom: z.array(stableVersionSchema).max(32)
	})
);
const compatibility = Compatibility.parse(
	JSON.parse(readFileSync('docs/server-update-compatibility.json', 'utf8'))
);
const { values } = parseArgs({
	options: {
		target: { type: 'string' },
		archive: { type: 'string' }
	}
});
const target = z
	.enum(['x86_64-unknown-linux-gnu', 'aarch64-unknown-linux-gnu', 'x86_64-pc-windows-msvc'])
	.parse(values.target);
const archive = z.string().parse(values.archive);
if (archive !== `dist/release/bmuster-app-${target}.tar.gz`)
	throw new Error('Unexpected server update archive path.');
const version = stableVersionSchema.parse(
	z.object({ version: z.string() }).parse(JSON.parse(readFileSync('package.json', 'utf8'))).version
);
const releaseCompatibility = compatibility[version];
if (releaseCompatibility === undefined)
	throw new Error(`docs/server-update-compatibility.json has no entry for ${version}.`);
if (compareAgentVersions(releaseCompatibility.minimumLauncher, version) > 0)
	throw new Error('minimumLauncher cannot be newer than the release itself.');
// v0.3.x updated only the app in place; from the next release the bundle is the whole install,
// which their launcher cannot install, so they must see "re-run the installer" instead.
if (
	compareAgentVersions(version, LAST_APP_ONLY_RELEASE) > 0 &&
	compareAgentVersions(releaseCompatibility.minimumLauncher, LAST_APP_ONLY_RELEASE) <= 0
)
	throw new Error(
		`minimumLauncher must be newer than ${LAST_APP_ONLY_RELEASE}: no v0.3.x server can install a whole-install bundle.`
	);
if (
	releaseCompatibility.rollbackFrom.some(
		(older, index, all) => compareAgentVersions(older, version) >= 0 || all.indexOf(older) !== index
	)
)
	throw new Error('Rollback compatibility must list unique older stable releases.');
const signingPem = process.env['BMUSTER_RELEASE_SIGNING_KEY'] ?? '';
if (signingPem.trim() === '')
	throw new Error('BMUSTER_RELEASE_SIGNING_KEY is required to publish signed updates.');
const signingKey = createPrivateKey(signingPem);
if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error('Release key must be Ed25519.');
const publicDer = createPublicKey(signingKey).export({ format: 'der', type: 'spki' });
const derivedPublicKey = publicDer.subarray(publicDer.byteLength - 32).toString('base64');
if (derivedPublicKey !== PUBLIC_KEY)
	throw new Error('Signing key does not match the public key trusted by installed agents.');
const archiveBytes = readFileSync(archive);
if (archiveBytes.byteLength === 0 || archiveBytes.byteLength > 1024 ** 3)
	throw new Error('Server update archive exceeds the 1 GiB limit.');
const payload = Buffer.from(
	JSON.stringify({
		schemaVersion: 1,
		version,
		target,
		archive: `bmuster-app-${target}.tar.gz`,
		bytes: archiveBytes.byteLength,
		sha256: createHash('sha256').update(archiveBytes).digest('hex'),
		minimumLauncher: releaseCompatibility.minimumLauncher,
		nodeMajor: Number.parseInt(readFileSync('.node-version', 'utf8'), 10),
		rollbackFrom: releaseCompatibility.rollbackFrom
	})
);
const signature = sign(null, Buffer.concat([DOMAIN, payload]), signingKey);
writeFileSync(
	`dist/release/bmuster-app-${target}.json`,
	JSON.stringify({
		payload: payload.toString('base64'),
		signature: signature.toString('base64')
	}) + '\n'
);
console.log(`server:sign-update: signed BMuster ${version} update for ${target}`);
