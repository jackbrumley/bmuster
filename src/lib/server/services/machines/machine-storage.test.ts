import { describe, expect, it } from 'vitest';
import type { DriveSummary } from '#lib/domain/storage/storage.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { notificationEvents } from '../../database/schema.ts';
import { storeCheckInStorage } from './machine-storage.ts';

const NOW = 1_794_000_000_000;

function drive(mount: string, usedPercent: number): DriveSummary {
	return {
		mount,
		sizeBytes: 1000,
		freeBytes: 1000 - usedPercent * 10,
		lastScan: { kind: 'none' },
		scanning: { kind: 'idle' }
	};
}

describe('Disk nearly full is raised from the check-in (SPEC-STORAGE S23)', () => {
	it('once on reaching 90 %, again only after dropping below 85 % and filling again', () => {
		const database = testDatabase();
		const { machineId } = enrolFakeAgent(database, NOW);
		const report = (...drives: DriveSummary[]): void => {
			storeCheckInStorage(
				database,
				machineId,
				{ kind: 'reported', drives, cleanup: { kind: 'none' } },
				NOW
			);
		};
		const raised = () =>
			database
				.select()
				.from(notificationEvents)
				.all()
				.filter((event) => event.kind === 'disk-nearly-full')
				.map((event) => JSON.parse(event.detail) as Record<string, string>);

		report(drive('/', 80), drive('/home', 50));
		expect(raised()).toEqual([]);
		report(drive('/', 93), drive('/home', 50));
		expect(raised()).toEqual([expect.objectContaining({ drive: '/', used: '93 %', free: '70 B' })]);
		report(drive('/', 96), drive('/home', 50));
		report(drive('/', 88), drive('/home', 50));
		report(drive('/', 91), drive('/home', 91));
		expect(raised().map((detail) => detail['drive'])).toEqual(['/', '/home']);
		report(drive('/', 70), drive('/home', 91));
		report(drive('/', 92), drive('/home', 91));
		expect(raised().map((detail) => detail['drive'])).toEqual(['/', '/home', '/']);
	});

	it('an older agent reporting nothing changes nothing', () => {
		const database = testDatabase();
		const { machineId } = enrolFakeAgent(database, NOW);
		const before = database.select().from(notificationEvents).all();
		storeCheckInStorage(database, machineId, { kind: 'unreported' }, NOW);
		expect(database.select().from(notificationEvents).all()).toEqual(before);
	});
});
