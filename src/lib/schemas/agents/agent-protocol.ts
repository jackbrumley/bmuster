/**
 * What agents and the server say to each other (docs/specs/SPEC-ENROLMENT.md
 * sections 6.1, 7 and 8). The Rust side is agent/crates/protocol; both must
 * change together.
 */
import { z } from 'zod';
import { diagnosticJournalSchema } from '#lib/schemas/agents/diagnostics.ts';

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

/**
 * The list of people for the local page that the agent holds (SPEC-AGENT-LOCAL 7). Agents
 * older than per-person codes send nothing, which reads as `unsupported`.
 */
const localUsersHeldSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('unsupported') }),
	z.object({ kind: z.literal('none') }),
	z.object({ kind: z.literal('held'), hash: z.string().max(128) })
]);

export type LocalUsersHeld = z.infer<typeof localUsersHeldSchema>;

const updateVersion = z.string().min(1).max(64);
const updateReason = z.string().max(500);
const atMs = z.int().min(0);

/** The last update on the machine (SPEC-AGENT-UPDATES), as the launcher or worker recorded it. */
const updateEventSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }),
	z.object({ kind: z.literal('updated'), from: updateVersion, to: updateVersion, atMs }),
	z.object({
		kind: z.literal('rolled-back'),
		version: updateVersion,
		reason: updateReason,
		atMs
	}),
	z.object({ kind: z.literal('refused'), version: updateVersion, reason: updateReason, atMs })
]);

/**
 * Whether the agent can update itself. Agents from before SPEC-AGENT-UPDATES send nothing; they
 * have no launcher either.
 */
const updateReportSchema = z
	.discriminatedUnion('kind', [
		z.object({ kind: z.literal('no-launcher') }),
		z.object({ kind: z.literal('launcher'), last: updateEventSchema })
	])
	.default({ kind: 'no-launcher' });

export type UpdateReport = z.infer<typeof updateReportSchema>;

export const checkInRequestSchema = z.object({
	agentVersion: z.string().min(1).max(32),
	uptimeSeconds: z.int().min(0),
	signedInUser: signedInUserSchema,
	load: z.object({ cpuPercent: z.number().min(0).max(100), memoryUsedBytes: byteCount }),
	inventory: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('unchanged'), hash: z.string().length(64) }),
		z.object({ kind: z.literal('full'), hash: z.string().length(64), data: inventorySchema })
	]),
	localUsers: localUsersHeldSchema.default({ kind: 'unsupported' }),
	update: updateReportSchema
});

export type CheckInRequest = z.infer<typeof checkInRequestSchema>;

/** Someone who may sign in to the local page with their own code (SPEC-AGENT-LOCAL 7). */
export type LocalUser = { userId: string; name: string };

/** The list of people, only when the agent's hash differs; older agents get `unchanged`. */
export type LocalUsersUpdate =
	{ kind: 'unchanged' } | { kind: 'list'; hash: string; users: LocalUser[] };

/** A newer signed build for the agent to install (SPEC-AGENT-UPDATES), or none. */
export type UpdateOffer =
	| { kind: 'none' }
	| { kind: 'offer'; version: string; size: number; sha256: string; signature: string };

/** `machineName`: the machine's name in the console, which the agent's local page shows. */
export type CheckInReply = {
	checkInSeconds: number;
	inventoryWanted: boolean;
	machineName: string;
	localUsers: LocalUsersUpdate;
	update: UpdateOffer;
};

/** `POST /agent/v1/leave` (SPEC-AGENT-LOCAL): the agent moved to another server, or is being uninstalled. */
export const leaveRequestSchema = z.object({ reason: z.enum(['moved', 'uninstalled']) });

export type LeaveReason = z.infer<typeof leaveRequestSchema>['reason'];

/** The local page's TOTP secret is 20 random bytes (RFC 4226's recommended length). */
const TOTP_SECRET_BYTES = 20;

/** `POST /agent/v1/local-page` (SPEC-AGENT-LOCAL): what the console needs for the local page. */
export const localPageReportSchema = z.object({
	totpSecret: z
		.base64()
		.refine((text) => Buffer.from(text, 'base64').length === TOTP_SECRET_BYTES, {
			message: 'The secret must be 20 bytes'
		}),
	certificateSha256: z.string().regex(/^[0-9a-f]{64}$/),
	port: z.int().min(1).max(65_535)
});

export type LocalPageReport = z.infer<typeof localPageReportSchema>;

const localUserSchema = z.object({
	userId: z.string().min(1).max(64),
	name: z.string().max(255)
});

/** Whose code a local page session signed in with: the shared machine code, or people's own. */
const codeOwnersSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('machine') }),
	z.object({ kind: z.literal('people'), people: z.array(localUserSchema).max(32) })
]);

export type CodeOwners = z.infer<typeof codeOwnersSchema>;

const withCodes = { codes: codeOwnersSchema };
const serverUrl = z.string().max(2048);

/** Something that happened on the local page (SPEC-AGENT-LOCAL 7). */
const localEventSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('signed-in'), ...withCodes }),
	z.object({ kind: z.literal('signed-out'), ...withCodes }),
	z.object({ kind: z.literal('session-expired'), ...withCodes }),
	z.object({ kind: z.literal('wrong-code') }),
	z.object({ kind: z.literal('locked-out') }),
	z.object({ kind: z.literal('restarted'), ...withCodes }),
	z.object({ kind: z.literal('connection-tested'), ...withCodes, passed: z.boolean() }),
	z.object({ kind: z.literal('move-started'), ...withCodes, serverUrl }),
	z.object({ kind: z.literal('move-finished'), ...withCodes, serverUrl }),
	z.object({ kind: z.literal('move-failed'), ...withCodes, reason: z.string().max(2000) }),
	z.object({
		kind: z.literal('leaving'),
		...withCodes,
		reason: z.enum(['moved', 'uninstalled'])
	}),
	z.object({ kind: z.literal('uninstalled'), ...withCodes }),
	z.object({ kind: z.literal('dropped'), count: z.int().min(1) })
]);

export type LocalEvent = z.infer<typeof localEventSchema>;

/** At most this many events per request; the agent sends 100. */
const MAX_EVENTS_PER_REPORT = 100;

/** `POST /agent/v1/local-events` (signed): local page events, oldest first. */
export const localEventsReportSchema = z.object({
	sentAtMs: z.int().min(0),
	events: z
		.array(z.object({ seq: z.int().min(0), atMs: z.int().min(0), event: localEventSchema }))
		.max(MAX_EVENTS_PER_REPORT)
});

export type LocalEventsReport = z.infer<typeof localEventsReportSchema>;

/** Messages an agent sends on its live socket. */
export const agentSocketMessageSchema = z.discriminatedUnion('type', [
	z.object({
		type: z.literal('live'),
		cpuPercent: z.number().min(0).max(100),
		memoryUsedBytes: byteCount
	}),
	/** A `session-open` the agent would not start (SPEC-SESSIONS T3), and why. */
	z.object({
		type: z.literal('session-refused'),
		sessionId: z.string().max(64),
		message: z.string().max(2000)
	}),
	z.object({
		type: z.literal('diagnostics'),
		requestId: z.uuid(),
		agentVersion: z.string().min(1).max(64),
		capturedAtMs: z.int().min(0),
		lines: z.array(z.string().max(4096)).max(200),
		truncated: z.boolean(),
		journal: diagnosticJournalSchema
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
	| { type: 'pin-update'; next: ServerTrust }
	/** Start a session: a ticket (base64 JSON) and the server's signature over it (SPEC-SESSIONS T3). */
	| { type: 'session-open'; ticket: string; signature: string }
	/** A message box on the console session's screen, from `from` (Windows). */
	| { type: 'user-message'; from: string; text: string }
	| { type: 'diagnostics-request'; requestId: string };

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
