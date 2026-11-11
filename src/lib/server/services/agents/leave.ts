import { eq } from 'drizzle-orm';
import type { AuditKind } from '#lib/domain/activity/activity.ts';
import type { LeaveReason } from '#lib/schemas/agents/agent-protocol.ts';
import { machines } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import type { AuthenticatedAgent } from './agent-auth.ts';
import { disconnectAgent } from './live-agents.ts';

/**
 * The agent leaves this server (SPEC-AGENT-LOCAL 3), in a signed request: it
 * moved to another server, it is being uninstalled from its local page, or an
 * administrator at the machine ran `uninstall --purge`
 * (SPEC-LOCAL-PAGE-TRANSPARENCY). Like a removal the row stays for the history
 * and the machine is refused from now on; a move is also marked `movedAt`.
 * Audited with the System as actor.
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
				kind: auditKind(reason),
				target: machine.name,
				machineId: agent.machineId,
				detail: { hostname: machine.hostname }
			},
			now
		);
	});
	disconnectAgent(agent.machineId, 4001, 'revoked');
}

function auditKind(reason: LeaveReason): AuditKind {
	switch (reason) {
		case 'moved':
			return 'machine-moved';
		case 'uninstalled':
			return 'machine-uninstalled';
		case 'removed-at-machine':
			return 'machine-removed-at-machine';
	}
}
