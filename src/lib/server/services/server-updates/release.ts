import { createPublicKey, verify, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { compareAgentVersions } from '#lib/domain/machines/agent-version.ts';
import {
	serverManifestSchema,
	stableVersionSchema,
	type ServerManifest
} from '#lib/schemas/releases/server-updates.ts';

/** Public information, also compiled into the Rust launchers; its equality is tested. */
export const RELEASE_PUBLIC_KEY = '4fsv0lh4Z/b/FM4RTf65gzD2la6wUJyfYcWto3RIXjs=';
export const SERVER_SIGNING_DOMAIN = 'BMUSTER-SERVER-UPDATE-1\n';
export const REPOSITORY = 'jackbrumley/bmuster';
const DOWNLOAD_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([408, 500, 502, 503, 504]);
export type Download = (url: string, limit: number) => Promise<Uint8Array>;
const envelopeSchema = z.strictObject({
	payload: z.string().max(24_000),
	signature: z.string().max(100)
});
const githubReleaseSchema = z.object({
	tag_name: z.string(),
	draft: z.boolean(),
	prerelease: z.boolean(),
	body: z.string().nullable(),
	published_at: z.iso.datetime(),
	assets: z.array(z.object({ name: z.string(), size: z.int().nonnegative() })).max(100)
});

/** The raw 32-byte Ed25519 release key (standard base64) as a key object. */
export function releaseKey(publicKey: string): KeyObject {
	const keyBytes = Buffer.from(publicKey, 'base64');
	if (keyBytes.length !== 32) throw new Error('Invalid release key or signature.');
	return createPublicKey({
		key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), keyBytes]),
		type: 'spki',
		format: 'der'
	});
}

export function verifyManifest(bytes: Uint8Array, publicKey: string): ServerManifest {
	if (bytes.byteLength > 32 * 1024) throw new Error('The update manifest is too large.');
	const envelope = envelopeSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')));
	const payload = Buffer.from(envelope.payload, 'base64');
	const signature = Buffer.from(envelope.signature, 'base64');
	if (signature.length !== 64) throw new Error('Invalid release key or signature.');
	const key = releaseKey(publicKey);
	if (!verify(null, Buffer.concat([Buffer.from(SERVER_SIGNING_DOMAIN), payload]), key, signature))
		throw new Error('The server update signature is not trusted.');
	const manifest = serverManifestSchema.parse(JSON.parse(payload.toString('utf8')));
	if (manifest.archive !== `bmuster-app-${manifest.target}.tar.gz`)
		throw new Error('Unexpected update archive name.');
	return manifest;
}

export async function download(url: string, limit: number): Promise<Uint8Array> {
	let response: Response | undefined;
	for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
		try {
			response = await fetch(url, {
				headers: { 'user-agent': 'BMuster server update check', accept: 'application/json' },
				signal: AbortSignal.timeout(20_000)
			});
		} catch (error) {
			if (!isRetryableNetworkError(error) || attempt === DOWNLOAD_ATTEMPTS) throw error;
			await waitBeforeRetry(attempt);
			continue;
		}
		if (!RETRYABLE_STATUSES.has(response.status) || attempt === DOWNLOAD_ATTEMPTS) break;
		await response.body?.cancel();
		await waitBeforeRetry(attempt);
	}
	if (response === undefined) throw new Error('Update check did not receive a response.');
	if (!response.ok)
		throw new Error(
			`Update check returned HTTP ${String(response.status)}${response.status === 403 || response.status === 429 ? ' (GitHub rate limit)' : ''}.`
		);
	const final = new URL(response.url);
	if (
		final.protocol !== 'https:' ||
		![
			'api.github.com',
			'github.com',
			'release-assets.githubusercontent.com',
			'objects.githubusercontent.com'
		].includes(final.hostname)
	)
		throw new Error('Update metadata redirected outside its trusted HTTPS hosts.');
	const reader = response.body?.getReader();
	if (reader === undefined) throw new Error('Update metadata had no body.');
	const parts: Buffer[] = [];
	let size = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) throw new Error('Update metadata exceeds its size limit.');
			parts.push(Buffer.from(next.value));
		}
	} finally {
		await reader.cancel();
	}
	return Buffer.concat(parts);
}

function isRetryableNetworkError(error: unknown): boolean {
	return (
		error instanceof TypeError ||
		(error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
	);
}

function waitBeforeRetry(attempt: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, attempt * 250));
}

export async function newestRelease(
	current: string,
	target: string,
	get: Download,
	publicKey: string
) {
	const release = githubReleaseSchema.parse(
		JSON.parse(
			Buffer.from(
				await get(`https://api.github.com/repos/${REPOSITORY}/releases/latest`, 256 * 1024)
			).toString('utf8')
		)
	);
	if (release.draft || release.prerelease) throw new Error('GitHub returned a non-stable release.');
	const version = stableVersionSchema.parse(release.tag_name.replace(/^v/, ''));
	if (compareAgentVersions(version, current) <= 0) return null;
	const name = `bmuster-app-${target}.json`;
	if (
		!release.assets.some(
			(asset) => asset.name === name && asset.size > 0 && asset.size <= 32 * 1024
		)
	)
		throw new Error(
			'This release has no signed server update manifest for this platform; use the administrator installer.'
		);
	const manifest = verifyManifest(
		await get(`https://github.com/${REPOSITORY}/releases/download/v${version}/${name}`, 32 * 1024),
		publicKey
	);
	if (manifest.version !== version || manifest.target !== target)
		throw new Error('The signed update manifest names a different release or platform.');
	if (
		!release.assets.some(
			(asset) => asset.name === manifest.archive && asset.size === manifest.bytes
		)
	)
		throw new Error('The signed update archive is absent or has a different size.');
	return {
		version,
		notes: (release.body ?? '').slice(0, 20_000),
		publishedAtIso: release.published_at,
		manifest
	};
}
