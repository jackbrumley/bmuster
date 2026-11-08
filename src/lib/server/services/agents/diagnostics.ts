import type { ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';
import type { agentSocketMessageSchema } from '#lib/schemas/agents/agent-protocol.ts';
import { eq } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { machines } from '../../database/schema.ts';
import { recordAudit } from '../audit/audit.ts';

export type AgentDiagnosticsMessage = Extract<
	ReturnType<typeof agentSocketMessageSchema.parse>,
	{ type: 'diagnostics' }
>;

type PendingRequest = {
	machineId: string;
	resolve: (message: AgentDiagnosticsMessage | undefined) => void;
};

type DiagnosticsState = {
	pending: Map<string, PendingRequest>;
	lastRequestedAt: Map<string, number>;
};

const STATE_KEY = Symbol.for('bmuster.agent-diagnostics');
const REQUEST_TIMEOUT_MS = 10_000;
const RATE_LIMIT_MS = 10_000;

function isDiagnosticsState(value: unknown): value is DiagnosticsState {
	return (
		typeof value === 'object' &&
		value !== null &&
		'pending' in value &&
		value.pending instanceof Map &&
		'lastRequestedAt' in value &&
		value.lastRequestedAt instanceof Map
	);
}

function state(): DiagnosticsState {
	const existing: unknown = Reflect.get(globalThis, STATE_KEY);
	if (isDiagnosticsState(existing)) {
		return existing;
	}
	const created: DiagnosticsState = { pending: new Map(), lastRequestedAt: new Map() };
	Reflect.set(globalThis, STATE_KEY, created);
	return created;
}

export type DiagnosticsRequestResult =
	| { kind: 'received'; message: AgentDiagnosticsMessage }
	| { kind: 'not-found' }
	| { kind: 'offline' }
	| { kind: 'timed-out' }
	| { kind: 'rate-limited' };

/** Request diagnostics from one connected agent; replies are accepted once and from that agent. */
export async function requestAgentDiagnostics(
	database: Queryable,
	machineId: string,
	userId: string,
	send: (message: ServerSocketMessage) => boolean,
	now: number
): Promise<DiagnosticsRequestResult> {
	const machine = database
		.select({ name: machines.name })
		.from(machines)
		.where(eq(machines.id, machineId))
		.get();
	if (machine === undefined) {
		return { kind: 'not-found' };
	}
	const shared = state();
	const rateKey = `${userId}:${machineId}`;
	const lastRequestedAt = shared.lastRequestedAt.get(rateKey);
	if (lastRequestedAt !== undefined && now - lastRequestedAt < RATE_LIMIT_MS) {
		return { kind: 'rate-limited' };
	}
	shared.lastRequestedAt.set(rateKey, now);
	const requestId = crypto.randomUUID();
	const response = new Promise<AgentDiagnosticsMessage | undefined>((resolve) => {
		const timer = setTimeout(() => {
			shared.pending.delete(requestId);
			resolve(undefined);
		}, REQUEST_TIMEOUT_MS);
		timer.unref();
		shared.pending.set(requestId, {
			machineId,
			resolve: (message) => {
				clearTimeout(timer);
				resolve(message);
			}
		});
	});
	if (!send({ type: 'diagnostics-request', requestId })) {
		shared.pending.delete(requestId);
		return { kind: 'offline' };
	}
	const message = await response;
	if (message === undefined) {
		return { kind: 'timed-out' };
	}
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId },
			kind: 'agent-logs-viewed',
			target: machine.name,
			machineId,
			detail: {
				lines: String(message.lines.length),
				journalLines:
					message.journal.kind === 'available' ? String(message.journal.lines.length) : '0'
			}
		},
		now
	);
	return { kind: 'received', message };
}

/** Satisfy only the request for this machine; unknown, late and cross-machine replies are ignored. */
export function receiveAgentDiagnostics(
	machineId: string,
	message: AgentDiagnosticsMessage
): boolean {
	const pending = state().pending.get(message.requestId);
	if (pending?.machineId !== machineId) {
		return false;
	}
	state().pending.delete(message.requestId);
	pending.resolve(message);
	return true;
}
