import type { Grant } from '#lib/domain/access/access.ts';
import type { OsFamily } from './machine.ts';

/**
 * Sending a message to the person at a machine: a message box on the
 * console session's screen (Windows `WTSSendMessage`, which works on Home
 * editions too). Browser-safe.
 *
 * Who may: admins, and members with `desktop-control` or `terminal` on the
 * machine. A box popping up on someone's screen interrupts them as much as
 * taking control does, so watching (`desktop-view`) is not enough. Windows
 * only for now: Linux would need a notification in the seat0 user's own
 * session bus.
 */
export const USER_MESSAGE_MAX_LENGTH = 500;

export function canSendUserMessage(grants: readonly Grant[], osFamily: OsFamily): boolean {
	return (
		osFamily === 'windows' &&
		grants.some(
			(grant) => grant.permission === 'desktop-control' || grant.permission === 'terminal'
		)
	);
}
