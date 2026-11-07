import { describe, expect, it } from 'vitest';
import type { Machine, MachineInventory } from '#lib/domain/machines/machine.ts';
import { matchesFilter, toMachineRow } from './machine-row.ts';

const GB = 1024 ** 3;

function inventory(
	disks: { mount: string; sizeBytes: number; usedBytes: number }[],
	updates: number
): MachineInventory {
	return {
		kind: 'known',
		osName: 'Ubuntu',
		osVersion: '24.04',
		osBuild: '',
		updates: { kind: 'known', count: updates },
		cpuModel: 'Test CPU',
		cpuCores: 4,
		memoryTotalBytes: 16 * GB,
		disks,
		displayCount: 1,
		addresses: [],
		gpus: []
	};
}

function machine(overrides: Partial<Machine>): Machine {
	return {
		id: '11111111-1111-4111-8111-111111111111',
		name: 'Test',
		description: '',
		hostname: 'test',
		osFamily: 'linux',
		target: 'x86_64-unknown-linux-gnu',
		agentVersion: '0.2.0',
		update: { kind: 'up-to-date' },
		status: { kind: 'online' },
		lastUser: { kind: 'none' },
		live: {
			kind: 'known',
			cpuPercent: 12.6,
			memoryUsedBytes: 4 * GB,
			uptimeSeconds: 60,
			signedInUser: { kind: 'none' }
		},
		inventory: inventory([{ mount: '/', sizeBytes: 100 * GB, usedBytes: 50 * GB }], 0),
		enrolledIso: '2026-11-01T00:00:00.000Z',
		lastSeenIso: '2026-11-07T12:00:00.000Z',
		inUse: [],
		...overrides
	};
}

describe('Machines list rows', () => {
	it('works out live figures and the fullest disk for an online machine', () => {
		const row = toMachineRow(
			machine({
				inventory: inventory(
					[
						{ mount: '/', sizeBytes: 100 * GB, usedBytes: 50 * GB },
						{ mount: '/data', sizeBytes: 100 * GB, usedBytes: 80 * GB }
					],
					0
				)
			})
		);
		expect(row.cpuPercent).toBe(13);
		expect(row.memoryPercent).toBe(25);
		expect(row.disk).toEqual({ mount: '/data', percent: 80, detail: '20.0 GB free' });
		expect(row.attention).toBe(false);
	});

	it('has no live figures for an offline machine, or before the first inventory', () => {
		const offline = toMachineRow(
			machine({ status: { kind: 'offline', lastSeenIso: '2026-11-01T00:00:00.000Z' } })
		);
		expect([offline.cpuPercent, offline.memoryPercent]).toEqual([null, null]);
		const pending = toMachineRow(machine({ inventory: { kind: 'pending' } }));
		expect([pending.memoryPercent, pending.disk]).toEqual([null, undefined]);
	});

	it('needs attention for pending updates or a disk at 90% or more', () => {
		const updates = toMachineRow(machine({ inventory: inventory([], 3) }));
		const full = toMachineRow(
			machine({
				inventory: inventory([{ mount: 'C:', sizeBytes: 100 * GB, usedBytes: 90 * GB }], 0)
			})
		);
		for (const row of [updates, full]) {
			expect(row.attention).toBe(true);
			expect(matchesFilter(row, 'attention')).toBe(true);
		}
		expect(updates.updates).toBe(3);
	});

	it('filters by status', () => {
		const online = toMachineRow(machine({}));
		const offline = toMachineRow(
			machine({ status: { kind: 'offline', lastSeenIso: '2026-11-01T00:00:00.000Z' } })
		);
		expect([online, offline].filter((row) => matchesFilter(row, 'online'))).toEqual([online]);
		expect([online, offline].filter((row) => matchesFilter(row, 'offline'))).toEqual([offline]);
		expect([online, offline].filter((row) => matchesFilter(row, 'all'))).toHaveLength(2);
	});
});
