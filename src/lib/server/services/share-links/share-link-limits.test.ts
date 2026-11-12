import { describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { NOW } from '#tests/helpers/people.ts';
import { recordShareLinkFailure, SHARE_LINK_LIMIT, shareLinkPause } from './share-link-limits.ts';

describe('the share-link rate limit (SPEC-SHARE-LINKS D5)', () => {
	it('SL9: 10 failures within 15 minutes pause that address, and only that address', () => {
		const database = testDatabase();
		for (let index = 0; index < SHARE_LINK_LIMIT.failures - 1; index += 1) {
			recordShareLinkFailure(database, '203.0.113.9', NOW + index);
		}
		expect(shareLinkPause(database, '203.0.113.9', NOW + 100)).toEqual({ kind: 'none' });
		recordShareLinkFailure(database, '203.0.113.9', NOW + 100);
		expect(shareLinkPause(database, '203.0.113.9', NOW + 200)).toEqual({
			kind: 'paused',
			untilMs: NOW + SHARE_LINK_LIMIT.windowMs
		});
		expect(shareLinkPause(database, '203.0.113.10', NOW + 200)).toEqual({ kind: 'none' });
	});

	it('SL9: the pause lifts once the failures are older than the window', () => {
		const database = testDatabase();
		for (let index = 0; index < SHARE_LINK_LIMIT.failures; index += 1) {
			recordShareLinkFailure(database, '203.0.113.9', NOW);
		}
		expect(shareLinkPause(database, '203.0.113.9', NOW + SHARE_LINK_LIMIT.windowMs - 1).kind).toBe(
			'paused'
		);
		expect(shareLinkPause(database, '203.0.113.9', NOW + SHARE_LINK_LIMIT.windowMs)).toEqual({
			kind: 'none'
		});
	});
});
