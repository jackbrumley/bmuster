import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import type { AppDatabase } from '#lib/server/database/connection.ts';
import { openDatabase } from '#lib/server/database/connection.ts';
import { createJoinCode } from '#lib/server/services/agents/join-codes.ts';
import { enrolMachine } from '#lib/server/services/agents/enrolment.ts';
import { isRefusal, type AgentRefusal } from '#lib/server/services/agents/agent-refusal.ts';
import { requestMessage } from '#lib/server/services/agents/signing.ts';
import type { SignedRequest } from '#lib/server/services/agents/agent-auth.ts';
import type { InventoryWire } from '#lib/schemas/agents/agent-protocol.ts';
import type { ReleaseLookup } from '#lib/server/services/agents/releases.ts';

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
	const { code } = createJoinCode(
		database,
		{ maxUses: 1, minutes: 60, machineGroupIds: [], createdBy: null },
		now
	);
	const agent = enrolWithCode(database, code, 'test-host', now);
	if (isRefusal(agent)) {
		throw new Error(`Enrolment refused: ${agent.message}`);
	}
	return agent;
}

/** Enrols with a given code and a fresh key, as `hostname`; the refusal if the server says no. */
export function enrolWithCode(
	database: AppDatabase,
	code: string,
	hostname: string,
	now: number
): FakeAgent | AgentRefusal {
	const pair = generateKeyPairSync('ed25519');
	const publicKeyBase64 = pair.publicKey
		.export({ format: 'der', type: 'spki' })
		.subarray(-32)
		.toString('base64');
	const reply = enrolMachine(
		database,
		{
			code,
			publicKey: publicKeyBase64,
			hostname,
			name: 'Test machine',
			osFamily: 'linux',
			target: 'x86_64-unknown-linux-gnu',
			agentVersion: '0.1.0'
		},
		SERVER_PUBLIC_KEY,
		now
	);
	if (isRefusal(reply)) {
		return reply;
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
	network: [{ name: 'eth0', mac: '00:11:22:33:44:55', addresses: ['10.0.0.5'] }],
	gpus: [
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
	],
	display: {
		kind: 'linux',
		seat: {
			kind: 'active',
			sessionType: 'wayland',
			class: 'user',
			desktop: 'GNOME',
			state: 'active',
			lockedHint: { kind: 'unknown' }
		},
		cards: [
			{
				name: 'card1',
				driver: 'i915',
				kms: true,
				connectors: [{ name: 'HDMI-A-1', modes: ['2560x1440', '1920x1080'] }]
			}
		],
		uinput: { device: true, module: true },
		nvidiaModeset: { kind: 'present', value: 'Y' },
		programs: { xdgDesktopPortal: true, gstreamer: true, pipewiresrc: true },
		kernel: '6.8.0-45-generic',
		agentVersion: '0.4.0',
		launcherVersion: { kind: 'known', version: '0.4.0' },
		selinux: { kind: 'absent' }
	},
	power: {
		kind: 'reported',
		source: 'mains',
		batteryPercent: null,
		keepAwake: 'off',
		inhibitor: { kind: 'none' }
	}
};

/** A server with no signed agent builds (SPEC-AGENT-UPDATES): nothing to offer. */
export const NO_RELEASES: ReleaseLookup = () => undefined;
