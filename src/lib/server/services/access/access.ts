import type { ConsoleUser } from '#lib/domain/users/user.ts';

/**
 * Who may see a machine (AGENTS.md §11: every permission check goes through
 * here). Until access rules exist (SPEC-ACCESS) only admins see machines; the
 * rules will widen this without changing its callers.
 */
export function canSeeMachine(user: ConsoleUser, _machineId: string): boolean {
	return user.role === 'admin';
}
