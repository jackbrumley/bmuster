import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
	isAgentTarget,
	type AgentDownload,
	type AgentTarget
} from '#lib/domain/machines/agent-release.ts';
import { compareAgentVersions, isAgentVersion } from '#lib/domain/machines/agent-version.ts';
import { sha256Hex } from './signing.ts';

/**
 * Builds the server serves (SPEC-ENROLMENT 6.1): RELEASES_PATH/<version>/<target>/bmuster-agent[.exe],
 * with `<binary>.sig` beside it when the build is signed for automatic updates
 * (SPEC-AGENT-UPDATES). Versions are releases (`1.2.3`) or development builds
 * (`1.2.3-dev.20261107153000`).
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

/** The newest signed build for a target, if any: what check-ins and the console ask. */
export type ReleaseLookup = (target: string) => SignedRelease | undefined;

function binaryName(target: AgentTarget): string {
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

/** The newest version folder that has a build for `target`, or undefined. */
export function latestRelease(
	releasesPath: string,
	target: AgentTarget,
	origin: string
): ReleaseManifest | undefined {
	const version = versionsFor(releasesPath, target).at(-1);
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
	const version = versionsFor(releasesPath, target)
		.filter((candidate) => existsSync(`${binaryPath(releasesPath, candidate, target)}.sig`))
		.at(-1);
	if (version === undefined) {
		return undefined;
	}
	const path = binaryPath(releasesPath, version, target);
	const { size, sha256 } = fileFacts(path);
	return { version, size, sha256, signature: readFileSync(`${path}.sig`, 'utf8').trim() };
}

/** The lookup check-ins and the console use: the newest signed build in `releasesPath`. */
export function signedReleases(releasesPath: string): ReleaseLookup {
	return (target) =>
		isAgentTarget(target) ? latestSignedRelease(releasesPath, target) : undefined;
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

/** A release binary (a few MB), or undefined if there is no such build. */
export function releaseFile(
	releasesPath: string,
	version: string,
	target: AgentTarget
): { body: Uint8Array<ArrayBuffer>; size: number; fileName: string } | undefined {
	if (!isAgentVersion(version)) {
		return undefined;
	}
	const path = binaryPath(releasesPath, version, target);
	if (!existsSync(path)) {
		return undefined;
	}
	const body = new Uint8Array(readFileSync(path));
	return { body, size: body.byteLength, fileName: binaryName(target) };
}
