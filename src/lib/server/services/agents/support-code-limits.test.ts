import { describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { NOW } from '#tests/helpers/people.ts';
import {
	ADDRESS_LIMIT,
	recordSupportCodeFailure,
	SERVER_LIMIT,
	supportCodePause
} from './support-code-limits.ts';

const ADDRESS = '198.51.100.7';

describe('support code guessing limits (SPEC-JOIN 5, J4)', () => {
	it('lets the first 3 wrong codes through, then makes each try wait 5 seconds longer', () => {
		const database = testDatabase();
		const waits: number[] = [];
		let now = NOW;
		for (let failures = 1; failures <= 9; failures += 1) {
			recordSupportCodeFailure(database, ADDRESS, now);
			const pause = supportCodePause(database, ADDRESS, now);
			waits.push(pause.kind === 'paused' ? (pause.untilMs - now) / 1000 : 0);
			now = pause.kind === 'paused' ? pause.untilMs : now + 1000;
			expect(supportCodePause(database, ADDRESS, now)).toEqual({ kind: 'none' });
		}
		expect(waits).toEqual([0, 0, 5, 10, 15, 20, 25, 30, 35]);
	});

	it('pauses an address for 15 minutes after its 10th wrong code', () => {
		const database = testDatabase();
		for (let failures = 0; failures < ADDRESS_LIMIT.pauseAfter; failures += 1) {
			recordSupportCodeFailure(database, ADDRESS, NOW + failures * 60_000);
		}
		const latest = NOW + (ADDRESS_LIMIT.pauseAfter - 1) * 60_000;
		expect(supportCodePause(database, ADDRESS, latest + 14 * 60_000)).toEqual({
			kind: 'paused',
			untilMs: latest + ADDRESS_LIMIT.pauseMs,
			by: 'address'
		});
		expect(supportCodePause(database, '192.0.2.1', latest)).toEqual({ kind: 'none' });
		expect(supportCodePause(database, ADDRESS, latest + ADDRESS_LIMIT.pauseMs)).toEqual({
			kind: 'none'
		});
	});

	it('pauses everyone after 30 wrong codes from anywhere within 15 minutes', () => {
		const database = testDatabase();
		for (let failures = 0; failures < SERVER_LIMIT.failures - 1; failures += 1) {
			recordSupportCodeFailure(database, `10.0.0.${String(failures)}`, NOW);
		}
		expect(supportCodePause(database, ADDRESS, NOW)).toEqual({ kind: 'none' });
		recordSupportCodeFailure(database, '10.0.1.1', NOW);
		expect(supportCodePause(database, ADDRESS, NOW + 60_000)).toEqual({
			kind: 'paused',
			untilMs: NOW + SERVER_LIMIT.windowMs,
			by: 'server'
		});
		expect(supportCodePause(database, ADDRESS, NOW + SERVER_LIMIT.windowMs)).toEqual({
			kind: 'none'
		});
	});
});
