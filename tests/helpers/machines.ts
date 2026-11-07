import type { Machine } from '#lib/domain/machines/machine.ts';

/** An online Linux machine as the console sees it, for page tests. */
export const TEST_MACHINE: Machine = {
	id: '11111111-1111-4111-8111-111111111111',
	name: 'Reception PC',
	description: '',
	hostname: 'reception',
	osFamily: 'linux',
	target: 'x86_64-unknown-linux-gnu',
	agentVersion: '0.2.0',
	update: { kind: 'up-to-date' },
	status: { kind: 'online' },
	lastUser: { kind: 'none' },
	live: { kind: 'none' },
	inventory: { kind: 'pending' },
	enrolledIso: '2026-11-01T00:00:00.000Z',
	lastSeenIso: '2026-11-07T12:00:00.000Z',
	inUse: []
};
