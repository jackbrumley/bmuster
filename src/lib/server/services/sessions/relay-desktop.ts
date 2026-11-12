import { endReasonLabel, type SessionEndReason } from '#lib/domain/sessions/session.ts';
import {
	agentClipboardReplySchema,
	agentClipboardSharedSchema,
	viewerClipboardRequestSchema
} from '#lib/schemas/desktop/desktop.ts';
import type { ClipboardTransfer, SharedClipboard } from './session-record.ts';

/**
 * What the relay reads in a desktop session's text frames (SPEC-DESKTOP):
 * copy and paste (section 21), and the agent's end of the session.
 */

/** A viewer's copy or paste request, which needs control (SPEC-DESKTOP 21.6). */
export function isClipboardRequest(json: unknown): boolean {
	return viewerClipboardRequestSchema.safeParse(json).success;
}

/** A copy or paste the agent confirmed, for the audit: its direction and size, never the text. */
export function clipboardTransferOf(json: unknown): ClipboardTransfer | undefined {
	const reply = agentClipboardReplySchema.safeParse(json);
	if (!reply.success) {
		return undefined;
	}
	switch (reply.data.type) {
		case 'clipboard':
			return {
				direction: 'from-machine',
				bytes: Buffer.byteLength(reply.data.text, 'utf8'),
				at: Date.now()
			};
		case 'clipboard-sent':
			return { direction: 'to-machine', bytes: reply.data.bytes, at: Date.now() };
	}
}

/** No clipboard sharing yet. */
export function noSharedClipboard(): SharedClipboard {
	return {
		'to-machine': { transfers: 0, bytes: 0 },
		'from-machine': { transfers: 0, bytes: 0 }
	};
}

/**
 * Adds a clipboard sharing transfer the agent reported to the session's totals (SPEC-DESKTOP
 * 21.11): its size, never the text. Returns whether the message was one.
 */
export function countSharedClipboard(totals: SharedClipboard, json: unknown): boolean {
	const shared = agentClipboardSharedSchema.safeParse(json);
	if (!shared.success) {
		return false;
	}
	const [direction, bytes]: [ClipboardTransfer['direction'], number] =
		shared.data.type === 'clipboard-changed'
			? ['from-machine', Buffer.byteLength(shared.data.text, 'utf8')]
			: ['to-machine', shared.data.bytes];
	totals[direction].transfers += 1;
	totals[direction].bytes += bytes;
	return true;
}

/** What the viewer is told when the agent ends a desktop session. */
export function desktopEndedMessage(reason: SessionEndReason): string {
	switch (reason) {
		case 'closed':
			return 'The session was ended.';
		case 'disconnected-at-machine':
			return 'Someone at the machine pressed Disconnect.';
		case 'too-many-sessions':
			return 'This machine already has 4 desktop sessions open. Try again when one ends.';
		case 'agent-lost':
			return 'The machine stopped sending its screen.';
		case 'share-link-ended':
			return 'The share link ended.';
		case 'declined':
		case 'timed-out':
		case 'permission-removed':
		case 'no-browser':
		case 'exited':
		case 'failed':
		case 'refused':
		case 'idle':
		case 'agent-timeout':
		case 'unused':
		case 'server-restarted':
			return `${endReasonLabel(reason)}.`;
	}
}
