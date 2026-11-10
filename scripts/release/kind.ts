/**
 * What a pushed tag publishes (SPEC-TEST-CHANNEL T2), decided before anything
 * is built:
 *
 * - `vX.Y.Z` is a release: it must equal package.json's version, and the agents
 *   must carry the same version (agent/Cargo.toml), so a test version left in
 *   Cargo.toml never ships as a release.
 * - `vX.Y.Z-<pre>` (for example `v0.4.14-test.1`) is a test build: agent-only,
 *   published as a GitHub pre-release. It must equal agent/Cargo.toml's version
 *   and be newer than the release in package.json.
 */
import {
	compareAgentVersions,
	isAgentVersion,
	isPrereleaseVersion
} from '../../src/lib/domain/machines/agent-version.ts';

export type ReleaseKind =
	| { kind: 'release'; version: string }
	| { kind: 'prerelease'; version: string }
	| { kind: 'refused'; reason: string };

export function releaseKind(
	tag: string,
	packageVersion: string,
	agentVersion: string
): ReleaseKind {
	const version = tag.startsWith('v') ? tag.slice(1) : '';
	if (!isAgentVersion(version)) {
		return { kind: 'refused', reason: `Tag ${tag} is not vX.Y.Z or vX.Y.Z-test.N.` };
	}
	if (!isPrereleaseVersion(version)) {
		if (version !== packageVersion) {
			return {
				kind: 'refused',
				reason: `Tag ${tag} does not match package.json version v${packageVersion}. Bump package.json, commit, then tag.`
			};
		}
		if (version !== agentVersion) {
			return {
				kind: 'refused',
				reason: `Tag ${tag} does not match agent/Cargo.toml version ${agentVersion}. Set the agent to the release version, commit, then tag.`
			};
		}
		return { kind: 'release', version };
	}
	if (version !== agentVersion) {
		return {
			kind: 'refused',
			reason: `Test tag ${tag} does not match agent/Cargo.toml version ${agentVersion}. Set the agent to ${version}, commit, then tag.`
		};
	}
	if (!isAgentVersion(packageVersion) || compareAgentVersions(version, packageVersion) <= 0) {
		return {
			kind: 'refused',
			reason: `Test tag ${tag} is not newer than the release ${packageVersion}, so no server would offer it.`
		};
	}
	return { kind: 'prerelease', version };
}
