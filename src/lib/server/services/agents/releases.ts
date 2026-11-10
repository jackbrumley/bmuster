import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
	isAgentTarget,
	type AgentDownload,
	type AgentTarget
} from '#lib/domain/machines/agent-release.ts';
import {
	compareAgentVersions,
	isAgentVersion,
	isPrereleaseVersion
} from '#lib/domain/machines/agent-version.ts';
import { sha256Hex } from './signing.ts';

/**
 * Builds the server serves (SPEC-ENROLMENT 6.1): RELEASES_PATH/<version>/<target>/bmuster-agent[.exe],
 * with `<binary>.sig` beside it when the build is signed for automatic updates
 * (SPEC-AGENT-UPDATES). Versions are releases (`1.2.3`) or development builds
 * (`1.2.3-dev.20261107153000`). Test builds (SPEC-TEST-CHANNEL, `1.2.3-test.1`)
 * live in their own folder, laid out the same way, filled from GitHub.
 */
type ReleaseManifest = {
	version: string;
	target: AgentTarget;
	size: number;
	sha256: string;
	url: string;
};

/** A build the server can offer as an update: its details and release signature. */
export type SignedRelease = {
	version: string;
	size: number;
	sha256: string;
	signature: string;
};

/**
 * The newest signed builds for a target, if any: what check-ins and the
 * console ask. `full` is the release channel every machine follows; `test` is
 * the newest test build, which only the Test group may be offered.
 */
export type ReleaseLookup = {
	full: (target: string) => SignedRelease | undefined;
	test: (target: string) => SignedRelease | undefined;
};

export function binaryName(target: AgentTarget): string {
	return target.includes('windows') ? 'bmuster-agent.exe' : 'bmuster-agent';
}

function binaryPath(releasesPath: string, version: string, target: AgentTarget): string {
	return join(releasesPath, version, target, binaryName(target));
}

/** Every version folder with a build for `target`, oldest first. */
function versionsFor(releasesPath: string, target: AgentTarget): string[] {
	if (!existsSync(releasesPath)) {
		return [];
	}
	return readdirSync(releasesPath)
		.filter(isAgentVersion)
		.filter((version) => existsSync(binaryPath(releasesPath, version, target)))
		.sort(compareAgentVersions);
}

/**
 * Hashes by file, kept while the file's size and time are unchanged: check-ins
 * ask for the newest build every minute, and a build is a few megabytes.
 */
const hashes = new Map<string, { stamp: string; sha256: string; size: number }>();

function fileFacts(path: string): { size: number; sha256: string } {
	const stat = statSync(path);
	const stamp = `${String(stat.size)}:${String(stat.mtimeMs)}`;
	const known = hashes.get(path);
	if (known?.stamp === stamp) {
		return known;
	}
	const facts = { stamp, size: stat.size, sha256: sha256Hex(readFileSync(path)) };
	hashes.set(path, facts);
	return facts;
}

/**
 * The build installs hand out for `target`: the newest signed one, or, while
 * the server has no signed build at all, the newest unsigned one. Signed
 * builds win because a newly installed agent can then update itself, and
 * because an older unsigned folder with a plain version (`0.1.0`) would
 * otherwise outrank every development build of that version
 * (`0.1.0-dev.…` sorts before `0.1.0`) and installs would get the stale one.
 */
export function latestRelease(
	releasesPath: string,
	target: AgentTarget,
	origin: string
): ReleaseManifest | undefined {
	const versions = versionsFor(releasesPath, target);
	const signed = versions.filter((candidate) =>
		existsSync(`${binaryPath(releasesPath, candidate, target)}.sig`)
	);
	const version = (signed.length > 0 ? signed : versions).at(-1);
	if (version === undefined) {
		return undefined;
	}
	const { size, sha256 } = fileFacts(binaryPath(releasesPath, version, target));
	return {
		version,
		target,
		size,
		sha256,
		url: `${origin}/agent/v1/releases/${version}/${target}`
	};
}

/** The newest build for `target` that carries a release signature, or undefined. */
export function latestSignedRelease(
	releasesPath: string,
	target: AgentTarget
): SignedRelease | undefined {
	return newestSigned(releasesPath, target, () => true);
}

function newestSigned(
	releasesPath: string,
	target: AgentTarget,
	accept: (version: string) => boolean
): SignedRelease | undefined {
	const version = versionsFor(releasesPath, target)
		.filter(accept)
		.filter((candidate) => existsSync(`${binaryPath(releasesPath, candidate, target)}.sig`))
		.at(-1);
	if (version === undefined) {
		return undefined;
	}
	const path = binaryPath(releasesPath, version, target);
	const { size, sha256 } = fileFacts(path);
	return { version, size, sha256, signature: readFileSync(`${path}.sig`, 'utf8').trim() };
}

/**
 * The lookup check-ins and the console use: the newest signed build in
 * `releasesPath`, and the newest signed test build in `testBuildsPath` (only
 * versions with a pre-release part count there).
 */
export function signedReleases(releasesPath: string, testBuildsPath: string): ReleaseLookup {
	return {
		full: (target) =>
			isAgentTarget(target) ? latestSignedRelease(releasesPath, target) : undefined,
		test: (target) =>
			isAgentTarget(target) ? newestSigned(testBuildsPath, target, isPrereleaseVersion) : undefined
	};
}

/** Every build on the server, newest first, and whether it is signed: the Updates page. */
export function listReleases(
	releasesPath: string,
	targets: readonly AgentTarget[]
): { version: string; target: AgentTarget; signed: boolean }[] {
	return targets
		.flatMap((target) =>
			versionsFor(releasesPath, target).map((version) => ({
				version,
				target,
				signed: existsSync(`${binaryPath(releasesPath, version, target)}.sig`)
			}))
		)
		.sort((a, b) => compareAgentVersions(b.version, a.version) || a.target.localeCompare(b.target));
}

/** What Add machine offers for `target` (SPEC-INSTALL-OPTIONS M2). */
export function agentDownload(
	releasesPath: string,
	target: AgentTarget,
	origin: string
): AgentDownload {
	const manifest = latestRelease(releasesPath, target, origin);
	return manifest === undefined
		? { kind: 'none', target }
		: {
				kind: 'ready',
				target,
				version: manifest.version,
				size: manifest.size,
				sha256: manifest.sha256
			};
}

/**
 * A release binary (a few MB), or undefined if there is no such build. Test
 * builds are served from their own folder, so a Test machine can download the
 * build it was offered.
 */
export function releaseFile(
	releasesPath: string,
	testBuildsPath: string,
	version: string,
	target: AgentTarget
): { body: Uint8Array<ArrayBuffer>; size: number; fileName: string } | undefined {
	if (!isAgentVersion(version)) {
		return undefined;
	}
	const path = [releasesPath, ...(isPrereleaseVersion(version) ? [testBuildsPath] : [])]
		.map((folder) => binaryPath(folder, version, target))
		.find((candidate) => existsSync(candidate));
	if (path === undefined) {
		return undefined;
	}
	const body = new Uint8Array(readFileSync(path));
	return { body, size: body.byteLength, fileName: binaryName(target) };
}
