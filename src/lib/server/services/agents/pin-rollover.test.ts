import { afterEach, describe, expect, it } from 'vitest';
import type { ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { certificatePin, makeSelfSignedCertificate } from '../../crypto/self-signed-certificate.ts';
import type { ServedCertificate } from '../../tls/served-certificate.ts';
import { listAudit } from '../audit/audit.ts';
import { updateSetting } from '../settings/settings.ts';
import { agentConnected, disconnectAgent } from './live-agents.ts';
import {
	localCertificate,
	localNetworkModeChanged,
	localTlsStatus,
	pinUpdate,
	renewLocalCertificate
} from './local-tls.ts';

const KEY = Buffer.alloc(32, 3);
const NAMES = { commonName: 'office', dnsNames: ['office'], ipAddresses: ['192.168.1.20'] };
const PLAIN: ServedCertificate = { kind: 'plain' };

/** A connected agent that records what the server sends it. */
function connectAgent(machineId: string): ServerSocketMessage[] {
	const received: ServerSocketMessage[] = [];
	agentConnected(machineId, {
		send: (message) => {
			received.push(message);
		},
		close: () => undefined
	});
	connected.push(machineId);
	return received;
}

const connected: string[] = [];
afterEach(() => {
	for (const machineId of connected.splice(0)) {
		disconnectAgent(machineId, 1000, 'test over');
	}
});

async function setUp(): Promise<{ database: AppDatabase; adminId: string }> {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'a@example.com',
		role: 'admin',
		password: null
	});
	return { database, adminId: admin.id };
}

function turn(database: AppDatabase, adminId: string, on: boolean, served: ServedCertificate) {
	updateSetting(database, adminId, 'localNetworkMode', on, NOW);
	localNetworkModeChanged(database, KEY, served, NAMES, NOW);
}

function own(database: AppDatabase): Extract<ServedCertificate, { kind: 'own' }> {
	const certificate = localCertificate(database, KEY, NAMES, NOW);
	return { kind: 'own', ...certificate };
}

describe('pin rollover (L7)', () => {
	it('L7: with nothing about to change, agents hear the current trust (public)', async () => {
		const { database } = await setUp();
		expect(pinUpdate(database, PLAIN)).toEqual({ type: 'pin-update', next: { kind: 'public' } });
		expect(localTlsStatus(database, PLAIN)).toEqual({
			on: false,
			restartNeeded: false,
			served: { kind: 'none' }
		});
	});

	it('L7: turning the mode on tells every connected agent the new pin before the restart', async () => {
		const { database, adminId } = await setUp();
		const agent = connectAgent('machine-1');
		turn(database, adminId, true, PLAIN);
		const { pin } = localCertificate(database, KEY, NAMES, NOW);
		expect(agent).toEqual([{ type: 'pin-update', next: { kind: 'pin', pin } }]);
		// Agents that connect before the restart hear it too.
		expect(pinUpdate(database, PLAIN)).toEqual({ type: 'pin-update', next: { kind: 'pin', pin } });
		expect(localTlsStatus(database, PLAIN).restartNeeded).toBe(true);
		// After the restart the server serves that certificate: nothing is pending.
		expect(localTlsStatus(database, own(database)).restartNeeded).toBe(false);
	});

	it('L7: turning the mode off tells agents to go back to normal certificate checks', async () => {
		const { database, adminId } = await setUp();
		turn(database, adminId, true, PLAIN);
		const served = own(database);
		const agent = connectAgent('machine-2');
		turn(database, adminId, false, served);
		expect(agent).toEqual([{ type: 'pin-update', next: { kind: 'public' } }]);
		expect(pinUpdate(database, served)).toEqual({
			type: 'pin-update',
			next: { kind: 'public' }
		});
		expect(localTlsStatus(database, served)).toEqual({
			on: false,
			restartNeeded: true,
			served: { kind: 'pin', ...certificatePin(served.certificatePem) }
		});
	});

	it('L7: a new certificate is announced at once, served after the restart, and audited', async () => {
		const { database, adminId } = await setUp();
		turn(database, adminId, true, PLAIN);
		const served = own(database);
		const agent = connectAgent('machine-3');
		renewLocalCertificate(database, KEY, served, NAMES, adminId, NOW + 1);
		const renewed = localCertificate(database, KEY, NAMES, NOW + 2);
		expect(renewed.pin).not.toBe(certificatePin(served.certificatePem).pin);
		expect(agent).toEqual([{ type: 'pin-update', next: { kind: 'pin', pin: renewed.pin } }]);
		expect(localTlsStatus(database, served).restartNeeded).toBe(true);
		expect(listAudit(database, 1)).toEqual([
			expect.objectContaining({
				kind: 'local-certificate-renewed',
				actorUserId: adminId,
				detail: { pin: renewed.pin }
			})
		]);
	});

	it('L7: the dev server always announces the certificate Vite serves', async () => {
		const { database, adminId } = await setUp();
		const dev: ServedCertificate = {
			kind: 'dev',
			certificatePem: makeSelfSignedCertificate(NAMES, NOW).certificatePem
		};
		turn(database, adminId, true, dev);
		const { pin } = certificatePin(dev.certificatePem);
		expect(pinUpdate(database, dev)).toEqual({ type: 'pin-update', next: { kind: 'pin', pin } });
		expect(localTlsStatus(database, dev).restartNeeded).toBe(false);
	});
});
