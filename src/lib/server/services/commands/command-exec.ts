import { createHash } from 'node:crypto';
import { COMMAND_LIMITS, type CommandShell } from '#lib/domain/commands/commands.ts';
import { agentSessionEventSchema } from '#lib/schemas/sessions/sessions.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { sendToAgent } from '../agents/live-agents.ts';
import { serverKey } from '../agents/server-keys.ts';
import type { Relay } from '../sessions/relay.ts';
import type { EndedSession, LocalEnd, SessionRecord } from '../sessions/session-record.ts';
import { signTicket, TICKET_LIFETIME_MS } from '../sessions/session-ticket.ts';

/**
 * One machine's part of a run (SPEC-COMMANDS C13): its own signed `exec` ticket naming the
 * machine, the person, the exact command, shell, time limit and output cap, and the
 * permissions the person holds there. The relay carries it like any session, with the server
 * as the other end: stdout and stderr frames (first byte 1 or 2) are kept up to 1 MB each, and
 * the agent's `exec-done` is the result.
 */

/** First byte of an exec output frame (agent/crates/protocol/src/session.rs). */
const EXEC_STDOUT = 1;
const EXEC_STDERR = 2;

/** Both streams' caps: the agent's cap counts them together (`maxOutputBytes`). */
const AGENT_OUTPUT_CAP = COMMAND_LIMITS.maxOutputBytesPerStream * 2;

/** How long past its time limit a command may go quiet before the server gives up on it. */
const GRACE_MS = 30_000;

export type ExecRequest = {
	runId: string;
	machineId: string;
	user: { id: string; name: string };
	/** How a machine's "In use" names it: "Jack Brumley (asked via Claude Code)". */
	inUseName: string;
	permissions: string[];
	shell: CommandShell;
	command: string;
	timeoutMs: number;
	ip: string;
};

/** How one machine's command ended. */
export type ExecResult = {
	status: 'succeeded' | 'failed' | 'timed-out' | 'lost';
	/** Why it failed to run or was lost; null when the command itself ran. */
	reason: string | null;
	exitCode: number | null;
	durationMs: number;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	outputBytes: number;
	outputSha256: string;
	sessionId: string;
};

/** One stream's bytes, kept up to the cap. */
class Kept {
	#chunks: Uint8Array[] = [];
	bytes = 0;
	truncated = false;

	push(data: Uint8Array): void {
		const room = COMMAND_LIMITS.maxOutputBytesPerStream - this.bytes;
		if (data.byteLength > room) {
			this.truncated = true;
		}
		const kept = data.subarray(0, Math.max(0, room));
		if (kept.byteLength > 0) {
			this.#chunks.push(kept.slice());
			this.bytes += kept.byteLength;
		}
	}

	all(): Buffer {
		return Buffer.concat(this.#chunks);
	}
}

/**
 * Asks the agent to run the command. `onDone` hears the result once, however it ends. False
 * when the machine's live socket is gone (it is offline: nothing was sent).
 */
export function runOnMachine(
	database: AppDatabase,
	relay: Relay,
	secretsKey: Buffer,
	request: ExecRequest,
	now: number,
	onDone: (result: ExecResult) => void
): { kind: 'sent'; sessionId: string } | { kind: 'offline' } {
	const sessionId = crypto.randomUUID();
	const stdout = new Kept();
	const stderr = new Kept();
	let done: { exitCode: number; durationMs: number; truncated: boolean; timedOut: boolean } | null =
		null;

	const local: LocalEnd = {
		ready: () => undefined,
		text: (text) => {
			const parsed = agentSessionEventSchema.safeParse(parseJson(text));
			if (parsed.success && parsed.data.type === 'exec-done') {
				done = parsed.data;
			}
		},
		bytes: (data) => {
			if (data.byteLength < 1) {
				return;
			}
			const body = data.subarray(1);
			if (data[0] === EXEC_STDOUT) {
				stdout.push(body);
			} else if (data[0] === EXEC_STDERR) {
				stderr.push(body);
			}
		}
	};

	const grace = setTimeout(() => {
		relay.end(sessionId, 'agent-timeout', 'The machine did not finish the command in time.');
	}, request.timeoutMs + GRACE_MS);
	grace.unref();

	const onEnded = (ended: EndedSession): void => {
		clearTimeout(grace);
		const out = stdout.all();
		const err = stderr.all();
		const finished = done;
		// The agent's cap counts both streams: when it cut output off, each stream may be short.
		const agentCut = finished?.truncated === true;
		const base = {
			stdout: out.toString('utf8'),
			stderr: err.toString('utf8'),
			stdoutTruncated: stdout.truncated || agentCut,
			stderrTruncated: stderr.truncated || agentCut,
			outputBytes: out.byteLength + err.byteLength,
			outputSha256: createHash('sha256').update(out).update(err).digest('hex'),
			sessionId
		};
		if (finished !== null) {
			onDone({
				...base,
				status: finished.timedOut ? 'timed-out' : finished.exitCode === 0 ? 'succeeded' : 'failed',
				reason: null,
				exitCode: finished.timedOut ? null : finished.exitCode,
				durationMs: finished.durationMs
			});
			return;
		}
		const durationMs = Math.max(0, ended.endedAt - ended.openedAt);
		// The agent refused the ticket or could not start the shell: the command did not run.
		const couldNotRun = ended.reason === 'failed' || ended.reason === 'refused';
		onDone({
			...base,
			status: couldNotRun ? 'failed' : 'lost',
			reason: ended.message,
			exitCode: null,
			durationMs
		});
	};

	const record: SessionRecord = {
		id: sessionId,
		machineId: request.machineId,
		userId: request.user.id,
		userName: request.inUseName,
		viewer: { kind: 'user' },
		kind: 'exec',
		shell: request.shell,
		runId: request.runId,
		ip: request.ip,
		openedAt: now
	};
	const key = serverKey(database, secretsKey, now);
	const signed = signTicket(
		{
			sessionId,
			machineId: request.machineId,
			user: request.user,
			permissions: request.permissions,
			runAs: { kind: 'admin' },
			issuedAtMs: now,
			expiresAtMs: now + TICKET_LIFETIME_MS,
			purpose: {
				kind: 'exec',
				shell: request.shell,
				command: request.command,
				timeoutMs: request.timeoutMs,
				maxOutputBytes: AGENT_OUTPUT_CAP
			}
		},
		key.privateKey
	);
	let sent = false;
	relay.startLocal(
		record,
		(ended) => {
			// A machine that could not be asked is offline; its row says so, not "lost".
			if (sent) {
				onEnded(ended);
			} else {
				clearTimeout(grace);
			}
		},
		local
	);
	sent = sendToAgent(request.machineId, { type: 'session-open', ...signed });
	if (!sent) {
		relay.end(sessionId, 'agent-lost', 'This machine is offline.');
		return { kind: 'offline' };
	}
	return { kind: 'sent', sessionId };
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
