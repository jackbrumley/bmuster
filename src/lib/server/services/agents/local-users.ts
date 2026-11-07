import { createHash } from 'node:crypto';
import type {
	LocalUser,
	LocalUsersHeld,
	LocalUsersUpdate
} from '#lib/schemas/agents/agent-protocol.ts';
import type { Queryable } from '../../database/connection.ts';
import { localPagePeople } from '../access/access.ts';

/**
 * The list of people who may sign in to a machine's local page with their own code
 * (SPEC-AGENT-LOCAL 7), sent in a check-in reply only when the agent's copy differs.
 */

/** The list and its hash: lower-case hex SHA-256 of the list's JSON, in userId order. */
export function localUsersList(database: Queryable): { hash: string; users: LocalUser[] } {
	const users = localPagePeople(database);
	const hash = createHash('sha256').update(JSON.stringify(users)).digest('hex');
	return { hash, users };
}

/** What a check-in reply says about the list, given what the agent holds. */
export function localUsersUpdate(database: Queryable, held: LocalUsersHeld): LocalUsersUpdate {
	switch (held.kind) {
		case 'unsupported':
			return { kind: 'unchanged' };
		case 'none':
		case 'held': {
			const list = localUsersList(database);
			if (held.kind === 'held' && held.hash === list.hash) {
				return { kind: 'unchanged' };
			}
			return { kind: 'list', ...list };
		}
	}
}

/** Which codes the agent takes, from what its check-in said it holds. */
export function localCodesFrom(held: LocalUsersHeld): 'shared' | 'per-person' {
	return held.kind === 'unsupported' ? 'shared' : 'per-person';
}
