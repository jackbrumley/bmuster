import { describe, expect, it } from 'vitest';
import {
	NEW_UPDATE_RECORD,
	STAGE_MS,
	UPDATING_MS,
	advanceStage,
	firstStage,
	machineUpdateState,
	shouldOffer,
	channelLabel,
	updateBadge,
	type UpdateRecord
} from './agent-updates.ts';

const NOW = 1_794_000_000_000;
const LAUNCHED: UpdateRecord = { ...NEW_UPDATE_RECORD, launcher: true };
const LATEST = { kind: 'version', version: '0.2.0' } as const;

function offer(overrides: Partial<Parameters<typeof shouldOffer>[0]>): boolean {
	return shouldOffer({
		agentVersion: '0.1.0',
		latest: '0.2.0',
		record: LAUNCHED,
		policy: 'automatic',
		rollout: { kind: 'staged', paused: false, stage: 'all' },
		inEarlyGroup: false,
		bucket: 50,
		...overrides
	});
}

describe('staged roll-out (SPEC-AGENT-UPDATES)', () => {
	it('starts with the Early updates group if it has machines, then 10%, then everyone, an hour apart', () => {
		expect(firstStage(2)).toBe('early');
		expect(firstStage(0)).toBe('tenth');
		const start = { stage: 'early' as const, stageStartedAt: NOW };
		expect(advanceStage(start, NOW + STAGE_MS - 1).stage).toBe('early');
		expect(advanceStage(start, NOW + STAGE_MS)).toEqual({
			stage: 'tenth',
			stageStartedAt: NOW + STAGE_MS
		});
		expect(advanceStage(start, NOW + 5 * STAGE_MS).stage).toBe('all');
	});

	it('offers each stage to the right machines', () => {
		const early = { kind: 'staged', paused: false, stage: 'early' } as const;
		const tenth = { kind: 'staged', paused: false, stage: 'tenth' } as const;
		expect(offer({ rollout: early, inEarlyGroup: true })).toBe(true);
		expect(offer({ rollout: early, bucket: 3 })).toBe(false);
		expect(offer({ rollout: tenth, bucket: 9 })).toBe(true);
		expect(offer({ rollout: tenth, bucket: 10 })).toBe(false);
		expect(offer({ rollout: tenth, inEarlyGroup: true, bucket: 99 })).toBe(true);
		expect(offer({})).toBe(true);
	});

	it('holds back for a pause, Manual mode, a pin, a failure, no launcher or an up-to-date agent', () => {
		expect(offer({ rollout: { kind: 'staged', paused: true, stage: 'all' } })).toBe(false);
		expect(offer({ policy: 'manual' })).toBe(false);
		expect(offer({ record: { ...LAUNCHED, pinned: true } })).toBe(false);
		expect(offer({ record: NEW_UPDATE_RECORD })).toBe(false);
		expect(offer({ agentVersion: '0.2.0' })).toBe(false);
		const failed: UpdateRecord = {
			...LAUNCHED,
			lastEvent: { kind: 'rolled-back', version: '0.2.0', reason: 'x', atIso: '' }
		};
		expect(offer({ record: failed })).toBe(false);
		// A failure of an older version does not hold back the newer one.
		expect(
			offer({
				record: {
					...LAUNCHED,
					lastEvent: { kind: 'refused', version: '0.1.5', reason: 'x', atIso: '' }
				}
			})
		).toBe(true);
	});

	it('lets Update now jump a pause, Manual mode and a failure, but never a pin', () => {
		const requested: UpdateRecord = {
			...LAUNCHED,
			requested: { kind: 'version', version: '0.2.0' },
			lastEvent: { kind: 'rolled-back', version: '0.2.0', reason: 'x', atIso: '' }
		};
		expect(
			offer({
				record: requested,
				policy: 'manual',
				rollout: { kind: 'staged', paused: true, stage: 'early' }
			})
		).toBe(true);
		expect(offer({ record: { ...requested, pinned: true } })).toBe(false);
	});
});

describe('test builds (SPEC-TEST-CHANNEL)', () => {
	const TEST = { kind: 'test' } as const;

	it('T4: offers a test build at once, whatever the stage, but holds it back for Manual mode, a pin or a failure', () => {
		expect(offer({ rollout: TEST, latest: '0.2.0-test.1', bucket: 99 })).toBe(true);
		expect(offer({ rollout: TEST, latest: '0.2.0-test.1', policy: 'manual' })).toBe(false);
		expect(
			offer({ rollout: TEST, latest: '0.2.0-test.1', record: { ...LAUNCHED, pinned: true } })
		).toBe(false);
		const failed: UpdateRecord = {
			...LAUNCHED,
			lastEvent: { kind: 'rolled-back', version: '0.2.0-test.1', reason: 'x', atIso: '' }
		};
		expect(offer({ rollout: TEST, latest: '0.2.0-test.1', record: failed })).toBe(false);
		expect(
			offer({
				rollout: TEST,
				latest: '0.2.0-test.1',
				policy: 'manual',
				record: { ...failed, requested: { kind: 'version', version: '0.2.0-test.1' } }
			})
		).toBe(true);
	});

	it('T5: never offers a test build older than or equal to the running version', () => {
		expect(offer({ rollout: TEST, latest: '0.2.0-test.1', agentVersion: '0.2.0' })).toBe(false);
		expect(offer({ rollout: TEST, latest: '0.2.0-test.1', agentVersion: '0.2.0-test.1' })).toBe(
			false
		);
		expect(offer({ latest: '0.2.0', agentVersion: '0.2.0-test.1' })).toBe(true);
	});

	it('names each channel', () => {
		expect(channelLabel('test')).toBe('Test channel');
		expect(channelLabel('full')).toBe('Full releases');
	});
});

describe('update state and badges (SPEC-AGENT-UPDATES)', () => {
	function state(record: UpdateRecord, agentVersion = '0.1.0') {
		return machineUpdateState({ agentVersion, latest: LATEST, record, now: NOW });
	}

	it('names each state and shows a badge only when there is something to see', () => {
		expect(state(LAUNCHED, '0.2.0')).toEqual({ kind: 'up-to-date' });
		expect(updateBadge(state(LAUNCHED, '0.2.0'))).toEqual({ kind: 'none' });
		expect(
			machineUpdateState({
				agentVersion: '0.1.0',
				latest: { kind: 'none' },
				record: LAUNCHED,
				now: NOW
			})
		).toEqual({ kind: 'no-release' });

		expect(state(LAUNCHED)).toEqual({ kind: 'available', version: '0.2.0', needsReinstall: false });
		expect(state(NEW_UPDATE_RECORD)).toEqual({
			kind: 'available',
			version: '0.2.0',
			needsReinstall: true
		});
		expect(updateBadge(state(LAUNCHED))).toEqual({
			kind: 'shown',
			label: 'Update available',
			tone: 'warning'
		});

		const offered: UpdateRecord = {
			...LAUNCHED,
			offered: { kind: 'version', version: '0.2.0', atMs: NOW - 1000 }
		};
		expect(updateBadge(state(offered))).toMatchObject({ label: 'Updating' });
		const stale: UpdateRecord = {
			...offered,
			offered: { kind: 'version', version: '0.2.0', atMs: NOW - UPDATING_MS }
		};
		expect(updateBadge(state(stale))).toMatchObject({ label: 'Update available' });

		const rolledBack: UpdateRecord = {
			...LAUNCHED,
			lastEvent: { kind: 'rolled-back', version: '0.2.0', reason: 'no check-in', atIso: '' }
		};
		expect(state(rolledBack)).toEqual({
			kind: 'rolled-back',
			version: '0.2.0',
			reason: 'no check-in'
		});
		expect(updateBadge(state(rolledBack))).toMatchObject({ label: 'Rolled back', tone: 'danger' });

		const pinned = state({ ...LAUNCHED, pinned: true });
		expect(pinned).toEqual({ kind: 'pinned', available: { kind: 'version', version: '0.2.0' } });
		expect(updateBadge(pinned)).toMatchObject({ label: 'Pinned' });
	});
});
