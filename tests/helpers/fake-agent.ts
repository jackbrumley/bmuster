import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { AppDatabase } from '#lib/server/database/connection.ts';
import { openDatabase } from '#lib/server/database/connection.ts';
import { createJoinCode } from '#lib/server/services/agents/join-codes.ts';
import { enrolMachine } from '#lib/server/services/agents/enrolment.ts';
import { isRefusal } from '#lib/server/services/agents/agent-refusal.ts';
import { requestMessage } from '#lib/server/services/agents/signing.ts';
import type { SignedRequest } from '#lib/server/services/agents/agent-auth.ts';
import type { InventoryWire } from '#lib/schemas/agents/agent-protocol.ts';

/** A fresh, migrated in-memory database for one test file. */
export function testDatabase(): AppDatabase {
	return openDatabase(':memory:');
}

export const SERVER_PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');

export type FakeAgent = {
	machineId: string;
	privateKey: KeyObject;
	publicKeyBase64: string;
	signed(method: string, path: string, body: string, timestampMs: number): SignedRequest;
};

/** Enrols a machine the way the Rust agent does, and can sign requests as it. */
export function enrolFakeAgent(database: AppDatabase, now: number): FakeAgent {
	const pair = generateKeyPairSync('ed25519');
	const publicKeyBase64 = pair.publicKey
		.export({ format: 'der', type: 'spki' })
		.subarray(-32)
		.toString('base64');
	const { code } = createJoinCode(
		database,
		{ maxUses: 1, minutes: 60, machineGroupIds: [], createdBy: null },
		now
	);
	const reply = enrolMachine(
		database,
		{
			code,
			publicKey: publicKeyBase64,
			hostname: 'test-host',
			name: 'Test machine',
			osFamily: 'linux',
			target: 'x86_64-unknown-linux-gnu',
			agentVersion: '0.1.0'
		},
		SERVER_PUBLIC_KEY,
		now
	);
	if (isRefusal(reply)) {
		throw new Error(`Enrolment refused: ${reply.message}`);
	}
	return {
		machineId: reply.machineId,
		privateKey: pair.privateKey,
		publicKeyBase64,
		signed(method, path, body, timestampMs) {
			const bytes = Buffer.from(body, 'utf8');
			const signature = sign(
				null,
				requestMessage(method, path, timestampMs, bytes),
				pair.privateKey
			);
			return {
				method,
				path,
				authorization: `BMuster ${reply.machineId}:${timestampMs}:${signature.toString('base64')}`,
				body: bytes
			};
		}
	};
}

export const SAMPLE_INVENTORY: InventoryWire = {
	os: {
		family: 'linux',
		name: 'Ubuntu',
		version: '24.04',
		build: '6.8.0',
		updatesPending: { kind: 'known', count: 3 }
	},
	hostname: 'test-host',
	cpu: { model: 'Test CPU', cores: 8 },
	memoryTotalBytes: 16 * 1024 ** 3,
	disks: [{ mount: '/', sizeBytes: 500 * 1024 ** 3, usedBytes: 200 * 1024 ** 3 }],
	displays: [],
	network: [{ name: 'eth0', mac: '00:11:22:33:44:55', addresses: ['10.0.0.5'] }]
};
