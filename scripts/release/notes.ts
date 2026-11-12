/**
 * The body of a GitHub release, written from the changelog
 * (src/lib/domain/releases/changelog.ts): what changed, then what to test on
 * real machines, so whoever installs a release knows what to try by hand.
 */
import type { Release } from '../../src/lib/domain/releases/changelog.ts';

const TESTING_HEADING = 'What to test on real machines';

export type ReleaseNotes = { kind: 'notes'; body: string } | { kind: 'missing'; reason: string };

export function releaseNotes(version: string, changelog: readonly Release[]): ReleaseNotes {
	const release = changelog.find((entry) => entry.version === version);
	if (release === undefined) {
		return {
			kind: 'missing',
			reason: `The changelog has no entry for ${version}. Add one to src/lib/domain/releases/changelog.ts, commit, then tag.`
		};
	}
	const lines = [
		'## What changed',
		'',
		...release.changes.map(bullet),
		'',
		`## ${TESTING_HEADING}`,
		''
	];
	switch (release.testing.kind) {
		case 'none':
			lines.push('Nothing listed for this release.');
			break;
		case 'steps':
			lines.push(...release.testing.steps.map(bullet));
			break;
	}
	return { kind: 'notes', body: `${lines.join('\n')}\n` };
}

function bullet(text: string): string {
	return `- ${text}`;
}
