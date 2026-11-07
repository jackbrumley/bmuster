/**
 * What agents and the server say to each other (docs/specs/SPEC-ENROLMENT.md
 * sections 6.1, 7 and 8). The Rust side is agent/crates/protocol; both must
 * change together.
 */
import { z } from 'zod';

const osFamilySchema = z.enum(['windows', 'linux', 'macos']);

export const enrolRequestSchema = z.object({
	code: z.string().min(1).max(32),
	publicKey: z.base64().length(44),
	hostname: z.string().min(1).max(255),
	name: z.string().min(1).max(255),
	osFamily: osFamilySchema,
	target: z.string().min(1).max(64),
	agentVersion: z.string().min(1).max(32)
});

export type EnrolRequest = z.infer<typeof enrolRequestSchema>;

export type EnrolReply = {
	machineId: string;
	serverPublicKey: string;
	checkInSeconds: number;
};

const signedInUserSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }),
	z.object({ kind: z.literal('user'), name: z.string().min(1).max(255) })
]);

const updatesPendingSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('unknown') }),
	z.object({ kind: z.literal('known'), count: z.int().min(0) })
]);

const byteCount = z.number().int().min(0);

/** One graphics card (SPEC-MACHINE-DETAILS D8). `driver` is '' when the system does not say. */
const gpuSchema = z.object({
	name: z.string().max(255),
	vendor: z.string().max(255),
	memoryBytes: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('unknown') }),
		z.object({ kind: z.literal('known'), bytes: byteCount })
	]),
	driver: z.string().max(255)
});

export const inventorySchema = z.object({
	os: z.object({
		family: osFamilySchema,
		name: z.string().max(255),
		version: z.string().max(255),
		build: z.string().max(255),
		updatesPending: updatesPendingSchema
	}),
	hostname: z.string().max(255),
	cpu: z.object({ model: z.string().max(255), cores: z.int().min(0) }),
	memoryTotalBytes: byteCount,
	disks: z
		.array(z.object({ mount: z.string().max(1024), sizeBytes: byteCount, usedBytes: byteCount }))
		.max(256),
	displays: z
		.array(
			z.object({
				index: z.int().min(0),
				width: z.int().min(0),
				height: z.int().min(0),
				primary: z.boolean()
			})
		)
		.max(32),
	network: z
		.array(
			z.object({
				name: z.string().max(255),
				mac: z.string().max(64),
				addresses: z.array(z.string().max(64)).max(64)
			})
		)
		.max(256),
	/** Agents before 0.2 sent no `gpus`; their inventories read as none reported. */
	gpus: z.array(gpuSchema).max(32).default([])
});

export type InventoryWire = z.infer<typeof inventorySchema>;

export const checkInRequestSchema = z.object({
	agentVersion: z.string().min(1).max(32),
	uptimeSeconds: z.int().min(0),
	signedInUser: signedInUserSchema,
	load: z.object({ cpuPercent: z.number().min(0).max(100), memoryUsedBytes: byteCount }),
	inventory: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('unchanged'), hash: z.string().length(64) }),
		z.object({ kind: z.literal('full'), hash: z.string().length(64), data: inventorySchema })
	])
});

export type CheckInRequest = z.infer<typeof checkInRequestSchema>;

export type CheckInReply = { checkInSeconds: number; inventoryWanted: boolean };

/** Messages an agent sends on its live socket. */
export const agentSocketMessageSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('live'),
		cpuPercent: z.number().min(0).max(100),
		memoryUsedBytes: byteCount
	})
]);

/**
 * How an agent checks the server's certificate (SPEC-INSTALL-OPTIONS L5, L7):
 * the operating system's trust store, or exactly one public key
 * (`sha256:<base64 of the SubjectPublicKeyInfo's SHA-256>`).
 */
export type ServerTrust = { kind: 'public' } | { kind: 'pin'; pin: string };

/** Messages the server sends on an agent's live socket. */
export type ServerSocketMessage =
	| { type: 'check-in-now' }
	| { type: 'watch'; intervalMs: number }
	| { type: 'unwatch' }
	/** The certificate the server will serve after its next restart (L7). */
	| { type: 'pin-update'; next: ServerTrust };

export type RefusalReason =
	| 'bad-request'
	| 'invalid-code'
	| 'expired-code'
	| 'used-code'
	| 'bad-signature'
	| 'stale-timestamp'
	| 'replayed-timestamp'
	| 'unknown-machine'
	| 'revoked';
