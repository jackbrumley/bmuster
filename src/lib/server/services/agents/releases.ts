import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentDownload, AgentTarget } from '#lib/domain/machines/agent-release.ts';
import { sha256Hex } from './signing.ts';

/** Builds the server serves (SPEC-ENROLMENT 6.1). Signing arrives with SPEC-AGENT-UPDATES. */
type ReleaseManifest = {
	version: string;
	target: AgentTarget;
	size: number;
	sha256: string;
	url: string;
};

function binaryName(target: AgentTarget): string {
	return target.includes('windows') ? 'bmuster-agent.exe' : 'bmuster-agent';
}

function binaryPath(releasesPath: string, version: string, target: AgentTarget): string {
	return join(releasesPath, version, target, binaryName(target));
}

/** The newest version folder that has a build for `target`, or undefined. */
export function latestRelease(
	releasesPath: string,
	target: AgentTarget,
	origin: string
): ReleaseManifest | undefined {
	if (!existsSync(releasesPath)) {
		return undefined;
	}
	const versions = readdirSync(releasesPath)
		.filter((version) => /^\d+\.\d+\.\d+$/.test(version))
		.filter((version) => existsSync(binaryPath(releasesPath, version, target)))
		.sort(compareVersions);
	const version = versions.at(-1);
	if (version === undefined) {
		return undefined;
	}
	const path = binaryPath(releasesPath, version, target);
	return {
		version,
		target,
		size: statSync(path).size,
		sha256: sha256Hex(readFileSync(path)),
		url: `${origin}/agent/v1/releases/${version}/${target}`
	};
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
	if (!/^\d+\.\d+\.\d+$/.test(version)) {
		return undefined;
	}
	const path = binaryPath(releasesPath, version, target);
	if (!existsSync(path)) {
		return undefined;
	}
	const body = new Uint8Array(readFileSync(path));
	return { body, size: body.byteLength, fileName: binaryName(target) };
}

function compareVersions(a: string, b: string): number {
	const left = a.split('.').map(Number);
	const right = b.split('.').map(Number);
	for (let index = 0; index < 3; index += 1) {
		const difference = (left[index] ?? 0) - (right[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
}
