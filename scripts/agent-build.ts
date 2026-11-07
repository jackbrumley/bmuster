/**
 * What the build scripts share about the Rust workspace in agent/: this
 * computer's target as the server names agent builds, and the agent version
 * from agent/Cargo.toml. Used by `agent:release-local` and
 * `release:server-local`.
 */
import { readFileSync } from 'node:fs';
import type { AgentTarget } from '../src/lib/domain/machines/agent-release.ts';

export const AGENT_MANIFEST = 'agent/Cargo.toml';

/** The executable name of a workspace binary on `target`. */
export function binaryName(name: string, target: AgentTarget): string {
	return target.includes('windows') ? `${name}.exe` : name;
}

/** This computer's Rust target, or undefined where no agent is built. */
export function hostTarget(): AgentTarget | undefined {
	switch (`${process.platform}-${process.arch}`) {
		case 'linux-x64':
			return 'x86_64-unknown-linux-gnu';
		case 'linux-arm64':
			return 'aarch64-unknown-linux-gnu';
		case 'win32-x64':
			return 'x86_64-pc-windows-msvc';
		default:
			return undefined;
	}
}

/** `version = "x.y.z"` from [workspace.package], else from [package]. */
export function agentVersion(): string {
	const text = readFileSync(AGENT_MANIFEST, 'utf8');
	for (const section of ['workspace.package', 'package']) {
		const body = text.split(`[${section}]`)[1]?.split(/^\[/m)[0];
		const version = body === undefined ? undefined : /^version\s*=\s*"([^"]+)"/m.exec(body)?.[1];
		if (version !== undefined) {
			if (!/^\d+\.\d+\.\d+$/.test(version)) {
				throw new Error(
					`${AGENT_MANIFEST} has version ${version}; the server serves only x.y.z versions`
				);
			}
			return version;
		}
	}
	throw new Error(`${AGENT_MANIFEST} has no version`);
}
