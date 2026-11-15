/**
 * Clean-ups an AI assistant asks for (SPEC-MCP M53–M56): each waits for a person's approval, as
 * an assistant's command does. Browser-safe: what the Approvals page and the approval card show,
 * and the words for them. Only item ids from the fixed list (SPEC-STORAGE 11.2) are ever asked for.
 */
import type { SignInCheck } from '#lib/domain/auth/sign-in-check.ts';
import type { OsFamily } from '#lib/domain/machines/machine.ts';
import { formatBytes } from '#lib/utils/format.ts';
import { cleanupLabel, type CleanupItemSize } from './cleanup.ts';

/** Where a request is up to; the database column holds the same values. */
export type CleanupRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

/** Clean-ups an assistant may ask for while others wait (approval fatigue, SPEC-MCP 11.3). */
export const CLEANUP_REQUEST_LIMITS = {
	/** Waiting requests per person; one per machine besides. */
	maxPending: 5,
	/** At most one Rescan now per machine per assistant connection this often (M52). */
	rescanEveryMs: 10 * 60_000
} as const;

/** "Old files in /var/tmp and Crash dumps", "Crash dumps, Package downloads and 2 more". */
export function itemsText(ids: readonly CleanupItemSize['id'][]): string {
	const labels = ids.map(cleanupLabel);
	if (labels.length <= 2) {
		return labels.join(' and ');
	}
	const [first = '', second = ''] = labels;
	return `${first}, ${second} and ${String(labels.length - 2)} more`;
}

/** The items' total, "4.6 GB", plus "and an unknown amount" when an item cannot be sized. */
export function totalText(sizes: readonly CleanupItemSize[]): string {
	const bytes = sizes.reduce(
		(sum, item) => sum + (item.size.kind === 'bytes' ? item.size.bytes : 0),
		0
	);
	const unknown = sizes.some((item) => item.size.kind === 'unknown');
	return `${formatBytes(bytes)}${unknown ? ' plus an unknown amount' : ''}`;
}

/** Whether the person looking at a clean-up request may decide it, and how they prove it is them. */
export type CleanupDecide = { kind: 'yes'; signIn: SignInCheck } | { kind: 'no'; why: string };

/** Where a request is up to, as its page shows it once it is no longer waiting. */
export type CleanupRequestState =
	| { kind: 'pending'; decide: CleanupDecide }
	| { kind: 'approved'; by: string }
	| { kind: 'denied'; by: string; note: string }
	| { kind: 'expired' }
	| { kind: 'cancelled' };

/** A clean-up request as its approval card shows it (M54). */
export type CleanupApprovalView = {
	requestId: string;
	machine: { id: string; name: string; osFamily: OsFamily; online: boolean };
	requestedBy: string;
	assistant: string;
	verified: boolean;
	reason: string;
	requestedIso: string;
	expiresIso: string;
	/** Each item with the machine's own size when the assistant asked. */
	items: CleanupItemSize[];
	state: CleanupRequestState;
};
