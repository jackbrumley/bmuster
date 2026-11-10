import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { releaseKind } from '../../scripts/release/kind.ts';

describe('what a tag publishes (SPEC-TEST-CHANNEL T2)', () => {
	it('T2: a plain version tag equal to package.json and the agent is a release', () => {
		expect(releaseKind('v0.4.14', '0.4.14', '0.4.14')).toEqual({
			kind: 'release',
			version: '0.4.14'
		});
	});

	it('T2: a pre-release tag equal to the agent version and newer than the release is a test build', () => {
		expect(releaseKind('v0.4.14-test.1', '0.4.13', '0.4.14-test.1')).toEqual({
			kind: 'prerelease',
			version: '0.4.14-test.1'
		});
	});

	it('T2: refuses tags that do not match, are not newer, or are not versions', () => {
		const refusals: [string, string, string, RegExp][] = [
			['v0.4.14', '0.4.13', '0.4.14', /package\.json/],
			// A test version left in Cargo.toml never ships as a release.
			['v0.4.14', '0.4.14', '0.4.14-test.2', /agent\/Cargo\.toml/],
			['v0.4.14-test.1', '0.4.13', '0.4.13', /agent\/Cargo\.toml/],
			['v0.4.13-test.1', '0.4.13', '0.4.13-test.1', /not newer/],
			['0.4.14', '0.4.14', '0.4.14', /not vX\.Y\.Z/],
			['v0.4', '0.4.14', '0.4.14', /not vX\.Y\.Z/],
			['v0.4.14+build', '0.4.14', '0.4.14', /not vX\.Y\.Z/]
		];
		for (const [tag, packageVersion, agentVersion, reason] of refusals) {
			const result = releaseKind(tag, packageVersion, agentVersion);
			expect(result.kind, tag).toBe('refused');
			expect(result.kind === 'refused' ? result.reason : '', tag).toMatch(reason);
		}
	});

	it('T2: the release workflow asks this script, marks test builds as pre-releases and keeps them off latest', () => {
		const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
		expect(workflow).toContain('node scripts/release-kind.ts "$GITHUB_REF_NAME"');
		expect(workflow).toMatch(/--prerelease[\s\\]+--latest=false/);
		// The server parts, their tests and the image run only for a release.
		for (const job of ['package', 'update-test-linux', 'image']) {
			const body = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n {2}[a-z-]+:\n/)[0] ?? '';
			expect(body, job).toContain("needs.check.outputs.kind == 'release'");
		}
	});
});
