import { verify } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { AGENT_TARGETS, type AgentTarget } from '#lib/domain/machines/agent-release.ts';
import { compareAgentVersions, isPrereleaseVersion } from '#lib/domain/machines/agent-version.ts';
import { releaseKey, REPOSITORY, type Download } from '../server-updates/release.ts';
import { releaseMessage } from './release-signing.ts';
import { binaryName } from './releases.ts';

/**
 * Test builds from GitHub (SPEC-TEST-CHANNEL): the newest pre-release whose
 * version is newer than the newest full build on this server, downloaded into
 * `<folder>/<version>/<target>/` laid out like RELEASES_PATH. Each build's
 * size and release signature are checked here before anything is stored, and
 * the agent checks them again with its own keys before it installs one.
 */

/** The agent's own limit for a build (agent/crates/agent/src/updates.rs). */
const MAX_BUILD_BYTES = 200 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const HOUR = 60 * 60 * 1000;
const FAILED_CHECK_RETRY = 5 * 60 * 1000;

const releaseListSchema = z
	.array(
		z.object({
			tag_name: z.string(),
			draft: z.boolean(),
			prerelease: z.boolean(),
			assets: z.array(z.object({ name: z.string(), size: z.int().nonnegative() })).max(100)
		})
	)
	.max(100);

/** What the release workflow names a test build's agent asset (`.sig` beside it). */
export function testAssetName(target: AgentTarget): string {
	return `bmuster-agent-${target}${target.includes('windows') ? '.exe' : ''}`;
}

export type TestBuildFetch = { kind: 'none' } | { kind: 'kept' | 'stored'; version: string };

/** Deletes every test build but `keep`, and any half-made folder. */
function prune(folder: string, keep: string | undefined): void {
	if (!existsSync(folder)) return;
	for (const name of readdirSync(folder)) {
		if (name !== keep) rmSync(join(folder, name), { recursive: true, force: true });
	}
}

/**
 * Fetches the newest test build if it is newer than `newestFull`. Fails
 * closed: a bad signature, size or asset throws with nothing stored.
 */
export async function fetchTestBuild(input: {
	folder: string;
	newestFull: string | undefined;
	get: Download;
	publicKey: string;
}): Promise<TestBuildFetch> {
	const { folder, newestFull, get, publicKey } = input;
	const releases = releaseListSchema.parse(
		JSON.parse(
			Buffer.from(
				await get(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`, 1024 * 1024)
			).toString('utf8')
		)
	);
	const newest = releases
		.filter((release) => !release.draft && release.prerelease)
		.map((release) => ({ ...release, version: release.tag_name.replace(/^v/, '') }))
		.filter((release) => `v${release.version}` === release.tag_name)
		.filter((release) => isPrereleaseVersion(release.version))
		.sort((a, b) => compareAgentVersions(b.version, a.version))
		.at(0);
	if (
		newest === undefined ||
		(newestFull !== undefined && compareAgentVersions(newest.version, newestFull) <= 0)
	) {
		prune(folder, undefined);
		return { kind: 'none' };
	}
	const { version } = newest;
	if (existsSync(join(folder, version))) {
		prune(folder, version);
		return { kind: 'kept', version };
	}
	const builds: { target: AgentTarget; bytes: Uint8Array; signature: string }[] = [];
	for (const target of AGENT_TARGETS) {
		const name = testAssetName(target);
		const binary = newest.assets.find((asset) => asset.name === name);
		const signatureAsset = newest.assets.find((asset) => asset.name === `${name}.sig`);
		if (binary === undefined || signatureAsset === undefined) continue;
		if (binary.size === 0 || binary.size > MAX_BUILD_BYTES)
			throw new Error(`The test build ${version} for ${target} has an unbelievable size.`);
		const base = `https://github.com/${REPOSITORY}/releases/download/v${version}`;
		const signature = Buffer.from(await get(`${base}/${name}.sig`, MAX_SIGNATURE_BYTES))
			.toString('utf8')
			.trim();
		const bytes = await get(`${base}/${name}`, binary.size);
		if (bytes.byteLength !== binary.size)
			throw new Error(`The test build ${version} for ${target} is not the size GitHub lists.`);
		const signatureBytes = Buffer.from(signature, 'base64');
		if (
			signatureBytes.length !== 64 ||
			!verify(
				null,
				Buffer.from(releaseMessage(version, target, bytes)),
				releaseKey(publicKey),
				signatureBytes
			)
		)
			throw new Error(`The test build ${version} for ${target} is not signed by the release key.`);
		builds.push({ target, bytes, signature });
	}
	if (builds.length === 0)
		throw new Error(`The test release ${version} on GitHub has no signed agent builds.`);
	const incoming = join(folder, `${version}.incoming`);
	rmSync(incoming, { recursive: true, force: true });
	for (const build of builds) {
		const dir = join(incoming, build.target);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, binaryName(build.target)), build.bytes, { mode: 0o644 });
		writeFileSync(join(dir, `${binaryName(build.target)}.sig`), `${build.signature}\n`, {
			mode: 0o644
		});
	}
	renameSync(incoming, join(folder, version));
	prune(folder, version);
	return { kind: 'stored', version };
}

export type TestChannelCheck = { checkedAtIso: string | null; problem: string | null };

/**
 * When to fetch: hourly, and on Check now, while the Test group has machines.
 * Five minutes after a failure. One fetch at a time.
 */
export class TestChannel {
	readonly #fetch: () => Promise<TestBuildFetch>;
	readonly #wanted: () => boolean;
	#status: TestChannelCheck = { checkedAtIso: null, problem: null };
	#pending: Promise<void> | undefined;

	constructor(fetch: () => Promise<TestBuildFetch>, wanted: () => boolean) {
		this.#fetch = fetch;
		this.#wanted = wanted;
	}

	status(): TestChannelCheck {
		return this.#status;
	}

	/** `checksOn`: the server's update-check setting, which also covers this. */
	due(now: number, checksOn: boolean): boolean {
		const checkedAt = this.#status.checkedAtIso;
		return (
			checksOn &&
			this.#wanted() &&
			(checkedAt === null ||
				now - Date.parse(checkedAt) >= (this.#status.problem === null ? HOUR : FAILED_CHECK_RETRY))
		);
	}

	check(now: number): Promise<void> {
		if (!this.#wanted()) return Promise.resolve();
		if (this.#pending !== undefined) return this.#pending;
		this.#pending = this.#fetch()
			.then(
				() => {
					this.#status = { checkedAtIso: new Date(now).toISOString(), problem: null };
				},
				(error: unknown) => {
					this.#status = {
						checkedAtIso: new Date(now).toISOString(),
						problem: error instanceof Error ? error.message : String(error)
					};
				}
			)
			.finally(() => {
				this.#pending = undefined;
			});
		return this.#pending;
	}
}
