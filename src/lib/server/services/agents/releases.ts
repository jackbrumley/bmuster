import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from './signing.ts';

/** Builds the server serves (SPEC-ENROLMENT 6.1). Signing arrives with SPEC-AGENT-UPDATES. */
const AGENT_TARGETS = [
	'x86_64-unknown-linux-gnu',
	'aarch64-unknown-linux-gnu',
	'x86_64-pc-windows-msvc'
] as const;

export type AgentTarget = (typeof AGENT_TARGETS)[number];

export type ReleaseManifest = {
	version: string;
	target: AgentTarget;
	size: number;
	sha256: string;
	url: string;
};

export function isAgentTarget(value: string): value is AgentTarget {
	return AGENT_TARGETS.some((target) => target === value);
}

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
