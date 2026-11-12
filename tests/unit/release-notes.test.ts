import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CHANGELOG, type Release } from '../../src/lib/domain/releases/changelog.ts';
import { releaseNotes } from '../../scripts/release/notes.ts';

const WITH_STEPS: Release = {
	version: '9.1.0',
	testing: {
		kind: 'steps',
		steps: [
			'On an Android phone, pinch to zoom the desktop',
			'On Fedora 44, sign in at the lock screen'
		]
	},
	changes: ['Pinch to zoom on phones', 'Lock screen sign-in']
};
const WITHOUT_STEPS: Release = {
	version: '9.0.0',
	testing: { kind: 'none' },
	changes: ['A fix nobody can see']
};

describe('GitHub release notes from the changelog (SPEC-RELEASE-NOTES)', () => {
	it('R2: lists what changed, then what to test on real machines', () => {
		expect(releaseNotes('9.1.0', [WITH_STEPS, WITHOUT_STEPS])).toEqual({
			kind: 'notes',
			body: [
				'## What changed',
				'',
				'- Pinch to zoom on phones',
				'- Lock screen sign-in',
				'',
				'## What to test on real machines',
				'',
				'- On an Android phone, pinch to zoom the desktop',
				'- On Fedora 44, sign in at the lock screen',
				''
			].join('\n')
		});
	});

	it('R2: says so when a release lists nothing to test by hand', () => {
		const notes = releaseNotes('9.0.0', [WITH_STEPS, WITHOUT_STEPS]);
		expect(notes).toEqual({
			kind: 'notes',
			body: [
				'## What changed',
				'',
				'- A fix nobody can see',
				'',
				'## What to test on real machines',
				'',
				'Nothing listed for this release.',
				''
			].join('\n')
		});
	});

	it('R3: refuses a version the changelog has no entry for', () => {
		const notes = releaseNotes('9.2.0', [WITH_STEPS]);
		expect(notes.kind === 'missing' ? notes.reason : notes.body).toMatch(/no entry for 9\.2\.0/);
	});

	it('R2: the script prints the notes for the newest release tag', () => {
		const latest = CHANGELOG[0];
		const body = execFileSync(
			process.execPath,
			['scripts/release-notes.ts', `v${latest.version}`],
			{
				encoding: 'utf8'
			}
		);
		expect(body).toContain(`- ${latest.changes[0]}`);
		expect(body).toContain('## What to test on real machines');
	});

	it('R3: the script fails for a tag with no changelog entry', () => {
		expect(() =>
			execFileSync(process.execPath, ['scripts/release-notes.ts', 'v0.0.1'], { stdio: 'pipe' })
		).toThrow(/no entry for 0\.0\.1/);
	});

	it('R1: every changelog entry has a version once', () => {
		const versions = CHANGELOG.map((release) => release.version);
		expect(new Set(versions).size).toBe(versions.length);
	});
});
