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
		.max(256)
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

/** Messages the server sends on an agent's live socket. */
export type ServerSocketMessage =
	{ type: 'check-in-now' } | { type: 'watch'; intervalMs: number } | { type: 'unwatch' };

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
