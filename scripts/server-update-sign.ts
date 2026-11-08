/**
 * Sign the app-only archive made by release-server.ts. Compatibility entries
 * are explicit because rollback is safe only where the old app can open the
 * new database schema.
 */
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { compareAgentVersions } from '../src/lib/domain/machines/agent-version.ts';
import { stableVersionSchema } from '../src/lib/schemas/releases/server-updates.ts';

const DOMAIN = Buffer.from('BMUSTER-SERVER-UPDATE-1\n');
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
const releaseCompatibility = compatibility[version] ?? {
	minimumLauncher: version,
	rollbackFrom: []
};
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
