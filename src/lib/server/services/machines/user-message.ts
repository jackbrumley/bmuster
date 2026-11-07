import { canSendUserMessage } from '#lib/domain/machines/user-message.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';
import type { Queryable } from '../../database/connection.ts';
import { permissionsFor } from '../access/access.ts';
import { recordAudit } from '../audit/audit.ts';
import { activeMachineBasics } from './machine-views.ts';

/**
 * A message for the person at a machine (`#lib/domain/machines/user-message.ts`): the agent shows
 * it in a message box on the console session's screen. Audited with the text, which is shown to
 * the person anyway.
 */
export type UserMessageResult =
	| { kind: 'sent' }
	| { kind: 'not-found' }
	| { kind: 'not-allowed' }
	| { kind: 'unsupported' }
	| { kind: 'offline' };

/** `deliver` sends to the machine's live socket and says whether it was connected. */
export function sendUserMessage(
	database: Queryable,
	sender: ConsoleUser,
	machineId: string,
	text: string,
	now: number,
	deliver: (message: ServerSocketMessage) => boolean
): UserMessageResult {
	const grants = permissionsFor(database, sender, machineId);
	const machine = activeMachineBasics(database, machineId);
	if (machine === undefined || !grants.some((grant) => grant.permission === 'view')) {
		return { kind: 'not-found' };
	}
	if (machine.osFamily !== 'windows') {
		return { kind: 'unsupported' };
	}
	if (!canSendUserMessage(grants, machine.osFamily)) {
		return { kind: 'not-allowed' };
	}
	if (!deliver({ type: 'user-message', from: sender.name, text })) {
		return { kind: 'offline' };
	}
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: sender.id },
			kind: 'machine-message-sent',
			target: machine.name,
			machineId,
			detail: { message: text }
		},
		now
	);
	return { kind: 'sent' };
}
