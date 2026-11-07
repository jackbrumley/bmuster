import { eq } from 'drizzle-orm';
import type { LeaveReason } from '#lib/schemas/agents/agent-protocol.ts';
import { machines } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import type { AuthenticatedAgent } from './agent-auth.ts';
import { disconnectAgent } from './live-agents.ts';

/**
 * The agent leaves this server (SPEC-AGENT-LOCAL 3), in a signed request: it
 * moved to another server, or it is being uninstalled. Like a removal the
 * row stays for the history and the machine is refused from now on; a move
 * is also marked `movedAt`. Audited with the System as actor.
 */
export function recordLeave(
	database: AppDatabase,
	agent: AuthenticatedAgent,
	reason: LeaveReason,
	now: number
): void {
	database.transaction((tx) => {
		const machine = tx
			.update(machines)
			.set({ removedAt: new Date(now), movedAt: reason === 'moved' ? new Date(now) : null })
			.where(eq(machines.id, agent.machineId))
			.returning({ name: machines.name, hostname: machines.hostname })
			.get();
		recordAudit(
			tx,
			{
				actor: { kind: 'system' },
				kind: reason === 'moved' ? 'machine-moved' : 'machine-uninstalled',
				target: machine.name,
				machineId: agent.machineId,
				detail: { hostname: machine.hostname }
			},
			now
		);
	});
	disconnectAgent(agent.machineId, 4001, 'revoked');
}
