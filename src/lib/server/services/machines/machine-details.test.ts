import { describe, expect, it } from 'vitest';
import { checkInRequestSchema } from '#lib/schemas/agents/agent-protocol.ts';
import {
	machineDescriptionSchema,
	machineNameSchema,
	updateMachineDetailsRequestSchema
} from '#lib/schemas/machines/machine-details.ts';
import {
	SAMPLE_INVENTORY,
	enrolFakeAgent,
	testDatabase,
	NO_RELEASES
} from '#tests/helpers/fake-agent.ts';
import { recordCheckIn } from '../agents/check-in.ts';
import { updateMachineDetails } from './machine-details.ts';
import { findMachine, listMachines, removeMachine } from './machine-views.ts';

const NOW = 1_794_000_000_000;
const ADMIN_ID = crypto.randomUUID();
const HASH = 'b'.repeat(64);

function checkIn(signedInUser: { kind: 'none' } | { kind: 'user'; name: string }) {
	return {
		agentVersion: '0.2.0',
		uptimeSeconds: 60,
		update: { kind: 'no-launcher' as const },
		signedInUser,
		load: { cpuPercent: 5, memoryUsedBytes: 1024 },
		inventory: { kind: 'full' as const, hash: HASH, data: SAMPLE_INVENTORY },
		localUsers: { kind: 'unsupported' as const },
		checks: { kind: 'unreported' as const }
	};
}

describe('rename (D1)', () => {
	it('takes 1 to 80 characters on one line, trimmed', () => {
		expect(machineNameSchema.parse('  Reception PC  ')).toBe('Reception PC');
		expect(machineNameSchema.safeParse('').success).toBe(false);
		expect(machineNameSchema.safeParse('   ').success).toBe(false);
		expect(machineNameSchema.safeParse('x'.repeat(80)).success).toBe(true);
		expect(machineNameSchema.safeParse('x'.repeat(81)).success).toBe(false);
		expect(machineNameSchema.safeParse('two\nlines').success).toBe(false);
	});

	it('renames the machine everywhere the console shows it', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const result = updateMachineDetails(
			database,
			agent.machineId,
			{ name: 'Reception PC', description: '' },
			ADMIN_ID,
			NOW + 1
		);
		expect(result).toEqual({ kind: 'saved', name: 'Reception PC', description: '' });
		expect(findMachine(database, agent.machineId, NOW + 1, NO_RELEASES)?.name).toBe('Reception PC');
		expect(listMachines(database, NOW + 1, NO_RELEASES).map((machine) => machine.name)).toEqual([
			'Reception PC'
		]);
	});

	it('refuses an unknown or removed machine', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		removeMachine(database, agent.machineId, ADMIN_ID, NOW);
		for (const id of [crypto.randomUUID(), agent.machineId]) {
			expect(
				updateMachineDetails(database, id, { name: 'X', description: '' }, ADMIN_ID, NOW)
			).toEqual({ kind: 'no-machine' });
		}
	});
});

describe('description (D2)', () => {
	it('is plain text up to 500 characters, may be empty, keeps line breaks', () => {
		expect(machineDescriptionSchema.parse('')).toBe('');
		expect(machineDescriptionSchema.safeParse('x'.repeat(500)).success).toBe(true);
		expect(machineDescriptionSchema.safeParse('x'.repeat(501)).success).toBe(false);
		expect(machineDescriptionSchema.parse('Front desk\nLabel 14')).toBe('Front desk\nLabel 14');
		expect(
			updateMachineDetailsRequestSchema.safeParse({ name: 'A', description: '<b>bold</b>' }).success
		).toBe(true);
	});

	it('is saved and shown with the machine', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		expect(findMachine(database, agent.machineId, NOW, NO_RELEASES)?.description).toBe('');
		updateMachineDetails(
			database,
			agent.machineId,
			{ name: 'Test machine', description: 'Front desk, label 14' },
			ADMIN_ID,
			NOW + 1
		);
		expect(findMachine(database, agent.machineId, NOW + 1, NO_RELEASES)?.description).toBe(
			'Front desk, label 14'
		);
	});
});

describe('last signed-in user (D7)', () => {
	it('is none until a check-in reports a user, then kept after they sign out', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const as = { machineId: agent.machineId, checkInSeconds: 60 };
		expect(findMachine(database, agent.machineId, NOW, NO_RELEASES)?.lastUser).toEqual({
			kind: 'none'
		});

		recordCheckIn(database, as, checkIn({ kind: 'user', name: 'sarah.k' }), NOW + 1000);
		recordCheckIn(database, as, checkIn({ kind: 'none' }), NOW + 61_000);
		const later = NOW + 2 * 24 * 3_600_000;
		expect(findMachine(database, agent.machineId, later, NO_RELEASES)).toMatchObject({
			status: { kind: 'offline' },
			lastUser: { kind: 'user', name: 'sarah.k', seenIso: new Date(NOW + 1000).toISOString() }
		});
	});

	it('moves to the newest user reported', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const as = { machineId: agent.machineId, checkInSeconds: 60 };
		recordCheckIn(database, as, checkIn({ kind: 'user', name: 'sarah.k' }), NOW + 1000);
		recordCheckIn(database, as, checkIn({ kind: 'user', name: 'tom' }), NOW + 61_000);
		expect(listMachines(database, NOW + 61_000, NO_RELEASES)[0]?.lastUser).toEqual({
			kind: 'user',
			name: 'tom',
			seenIso: new Date(NOW + 61_000).toISOString()
		});
	});
});

describe('graphics cards (D8)', () => {
	it('shows every card the agent reported, with memory where known', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		recordCheckIn(
			database,
			{ machineId: agent.machineId, checkInSeconds: 60 },
			checkIn({ kind: 'none' }),
			NOW + 1000
		);
		const inventory = findMachine(database, agent.machineId, NOW + 1000, NO_RELEASES)?.inventory;
		expect(inventory?.kind === 'known' ? inventory.gpus : undefined).toEqual([
			{
				name: 'NVIDIA GeForce RTX 4070',
				vendor: 'NVIDIA Corporation',
				memoryBytes: { kind: 'known', bytes: 12 * 1024 ** 3 },
				driver: 'nvidia 550.54'
			},
			{
				name: 'Intel UHD Graphics 770',
				vendor: 'Intel Corporation',
				memoryBytes: { kind: 'unknown' },
				driver: 'i915'
			}
		]);
	});

	it('reads an inventory from an agent that sends no gpus as none reported', () => {
		const { gpus: _gpus, ...oldInventory } = SAMPLE_INVENTORY;
		const parsed = checkInRequestSchema.parse({
			...checkIn({ kind: 'none' }),
			inventory: { kind: 'full', hash: HASH, data: oldInventory }
		});
		expect(parsed.inventory.kind === 'full' ? parsed.inventory.data.gpus : undefined).toEqual([]);

		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		recordCheckIn(database, { machineId: agent.machineId, checkInSeconds: 60 }, parsed, NOW + 1);
		const inventory = findMachine(database, agent.machineId, NOW + 1, NO_RELEASES)?.inventory;
		expect(inventory?.kind === 'known' ? inventory.gpus : undefined).toEqual([]);
	});

	it('refuses a card with an unknown memory shape', () => {
		const result = checkInRequestSchema.safeParse({
			...checkIn({ kind: 'none' }),
			inventory: {
				kind: 'full',
				hash: HASH,
				data: {
					...SAMPLE_INVENTORY,
					gpus: [{ name: 'X', vendor: 'Y', memoryBytes: { kind: 'guess' }, driver: '' }]
				}
			}
		});
		expect(result.success).toBe(false);
	});
});
