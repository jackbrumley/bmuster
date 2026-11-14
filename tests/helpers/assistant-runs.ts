import { eq } from 'drizzle-orm';
import { expect } from 'vitest';
import { z } from 'zod';
import type { ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';
import type { ApproveRequest } from '#lib/schemas/commands/approvals.ts';
import type { AppDatabase } from '#lib/server/database/connection.ts';
import { machines } from '#lib/server/database/schema.ts';
import {
	agentConnected,
	agentDisconnected,
	type LivePeer
} from '#lib/server/services/agents/live-agents.ts';
import { startSession } from '#lib/server/services/auth/sessions.ts';
import { createCommandRunner } from '#lib/server/services/commands/command-runner.ts';
import type { CommandContext } from '#lib/server/services/commands/commands.ts';
import type { CommandToolContext } from '#lib/server/services/mcp/command-tools.ts';
import { authenticateAccessToken, type McpPrincipal } from '#lib/server/services/oauth/tokens.ts';
import { createRelay, RELAY_LIMITS, type RelayPeer } from '#lib/server/services/sessions/relay.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { grantAccess } from './access.ts';
import { enrolFakeAgent, testDatabase } from './fake-agent.ts';
import { connectAssistant, enableMcp, ORIGIN } from './mcp.ts';
import { addTestUser, NOW, PASSWORD } from './people.ts';

/**
 * A server with AI assistants on, for the step 2 tests (SPEC-MCP M17–M30): Ada (admin), Pat (a
 * member with AI commands and Run commands), Kim (a member with AI commands only), machines on
 * each system, a fake agent socket per machine, and Pat's assistant connected.
 */

const SECRETS_KEY = Buffer.alloc(32, 3);
export const MINUTE = 60_000;

/** The parts of an exec ticket these tests read. */
const ticketSchema = z.object({
	sessionId: z.string(),
	machineId: z.string(),
	permissions: z.array(z.string()),
	user: z.object({ id: z.string(), name: z.string() }),
	purpose: z.object({
		kind: z.string(),
		shell: z.string(),
		command: z.string(),
		timeoutMs: z.number()
	})
});

export type Ticket = z.infer<typeof ticketSchema>;

const connected: { machineId: string; peer: LivePeer }[] = [];

/** For afterEach: closes every fake agent socket. */
export function disconnectAgents(): void {
	for (const { machineId, peer } of connected.splice(0)) {
		agentDisconnected(machineId, peer);
	}
}

/** A live agent socket that keeps the tickets it is sent. */
export function connect(machineId: string): Ticket[] {
	const tickets: Ticket[] = [];
	const peer: LivePeer = {
		send: (message: ServerSocketMessage) => {
			if (message.type === 'session-open') {
				tickets.push(
					ticketSchema.parse(JSON.parse(Buffer.from(message.ticket, 'base64').toString('utf8')))
				);
			}
		},
		close: () => undefined
	};
	agentConnected(machineId, peer);
	connected.push({ machineId, peer });
	return tickets;
}

function quietPeer(): RelayPeer {
	return {
		sendText: () => undefined,
		sendBytes: (_data, sent) => {
			sent();
		},
		pause: () => undefined,
		resume: () => undefined,
		close: () => undefined
	};
}

/** The agent's side of one exec session: attach, send output frames, then the result. */
export function agentAnswers(
	relay: ReturnType<typeof createRelay>,
	ticket: Ticket,
	result: { stdout: string; stderr: string; exitCode: number }
): void {
	const peer = quietPeer();
	expect(relay.attachAgent(ticket.sessionId, ticket.machineId, peer)).toEqual({ kind: 'attached' });
	relay.fromAgent(
		ticket.sessionId,
		peer,
		Buffer.concat([Buffer.from([1]), Buffer.from(result.stdout)])
	);
	relay.fromAgent(
		ticket.sessionId,
		peer,
		Buffer.concat([Buffer.from([2]), Buffer.from(result.stderr)])
	);
	relay.agentText(
		ticket.sessionId,
		peer,
		JSON.stringify({
			type: 'exec-done',
			exitCode: result.exitCode,
			durationMs: 1200,
			truncated: false,
			timedOut: false
		})
	);
}

function enrol(
	database: AppDatabase,
	name: string,
	osFamily: 'linux' | 'windows' | 'macos',
	version = '0.4.27'
): string {
	const machineId = enrolFakeAgent(database, NOW).machineId;
	database
		.update(machines)
		.set({ name, hostname: name, osFamily, agentVersion: version })
		.where(eq(machines.id, machineId))
		.run();
	return machineId;
}

export async function setUpAssistantRuns() {
	const database = testDatabase();
	const admin = toConsoleUser(
		await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: PASSWORD })
	);
	const pat = toConsoleUser(
		await addTestUser(database, { email: 'pat@example.com', role: 'member', password: PASSWORD })
	);
	const kim = toConsoleUser(
		await addTestUser(database, { email: 'kim@example.com', role: 'member', password: PASSWORD })
	);
	const machine = {
		mint: enrol(database, 'mint', 'linux'),
		reception: enrol(database, 'reception', 'linux'),
		office: enrol(database, 'office', 'windows'),
		studio: enrol(database, 'studio', 'macos'),
		old: enrol(database, 'old', 'linux', '0.4.20'),
		payroll: enrol(database, 'payroll', 'linux')
	};
	const aiMachines = [machine.mint, machine.reception, machine.office, machine.studio, machine.old];
	const rules = {
		patAi: grantAccess(database, {
			adminId: admin.id,
			name: 'Pat AI',
			memberIds: [pat.id],
			machineIds: aiMachines,
			permissions: ['view', 'ai-commands', 'run-commands'],
			consent: 'unattended'
		}),
		payroll: grantAccess(database, {
			adminId: admin.id,
			name: 'Payroll',
			memberIds: [pat.id],
			machineIds: [machine.payroll],
			permissions: ['view', 'run-commands'],
			consent: 'unattended'
		}),
		kimAi: grantAccess(database, {
			adminId: admin.id,
			name: 'Kim AI',
			memberIds: [kim.id],
			machineIds: [machine.mint],
			permissions: ['view', 'ai-commands'],
			consent: 'unattended'
		}),
		adminAi: grantAccess(database, {
			adminId: admin.id,
			name: 'Ada AI',
			memberIds: [admin.id],
			machineIds: [machine.mint],
			permissions: ['view', 'ai-commands'],
			consent: 'unattended'
		})
	};
	enableMcp(database, admin.id, [pat.id, kim.id, admin.id]);
	const relay = createRelay(RELAY_LIMITS);
	const clock = { now: NOW + MINUTE };
	const runner = createCommandRunner({
		database,
		relay,
		secretsKey: SECRETS_KEY,
		clock: () => clock.now
	});
	const sessions = {
		admin: startSession(database, admin.id, { ip: '192.0.2.1', userAgent: 'Vitest' }, clock.now)
			.token,
		pat: startSession(database, pat.id, { ip: '192.0.2.2', userAgent: 'Vitest' }, clock.now).token,
		kim: startSession(database, kim.id, { ip: '192.0.2.3', userAgent: 'Vitest' }, clock.now).token
	};
	const people = { admin, pat, kim };
	type Who = keyof typeof people;

	/** A person's console request, as the approve and deny routes build it. */
	const consoleAs = (who: Who): CommandContext => ({
		database,
		runner,
		user: people[who],
		sessionToken: sessions[who],
		ip: '192.0.2.9',
		now: clock.now
	});

	/** A person's assistant, connected and authenticated as `/mcp` would see it. */
	const assistantOf = async (
		who: Who,
		kind: 'registered' | 'claude-code' = 'claude-code'
	): Promise<McpPrincipal> => {
		const connection = await connectAssistant(database, people[who].id, kind, clock.now);
		const check = authenticateAccessToken(
			database,
			connection.accessToken,
			{ ip: '198.51.100.7', userAgent: 'Claude Code' },
			clock.now
		);
		if (check.kind !== 'valid') throw new Error('The assistant did not authenticate');
		return check.principal;
	};

	const tools = (principal: McpPrincipal, waitMs = 0): CommandToolContext => ({
		database,
		runner,
		principal,
		origin: ORIGIN,
		clock: () => clock.now,
		waitMs
	});

	return {
		database,
		people,
		machine,
		rules,
		relay,
		runner,
		clock,
		consoleAs,
		assistantOf,
		tools
	};
}

/** Approve as asked: the command and time limit unchanged, the count typed, no password. */
export function asAsked(command: string, timeoutMs: number, count: number): ApproveRequest {
	return { command, timeoutMs, confirmCount: count, password: { kind: 'none' } };
}
