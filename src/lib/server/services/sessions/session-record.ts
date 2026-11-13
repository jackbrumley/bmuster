import type { DesktopMode, SessionEndReason, TerminalShell } from '#lib/domain/sessions/session.ts';
import type { GuestIdentity } from '#lib/domain/share-links/share-links.ts';

/**
 * The shapes of a session the relay keeps (`relay.ts`) and its owners
 * read: what was asked for, the server's own end of a file session, a
 * copy or paste on a desktop, and how a session ended.
 */

/**
 * Who a session is for: a console user, or the guest of a share link
 * (SPEC-SHARE-LINKS), who has no account. A guest's name and company are what
 * they typed (self-declared, D17); the browser line is cut to 300 characters.
 */
type SessionViewer =
	| { kind: 'user' }
	| {
			kind: 'guest';
			shareLinkId: string;
			sharedBy: { id: string; name: string };
			identity: GuestIdentity;
			userAgent: string;
	  };

/** What a session is, from the moment it is asked for. */
export type SessionRecord = {
	id: string;
	machineId: string;
	/**
	 * Whose session it is, for its browser tickets and the per-person limit:
	 * the user's id, or for a guest the share link's id (one session per link).
	 */
	userId: string;
	/** The name the machine and Activity show: the user's, or "<recipient> (shared by <name>)". */
	userName: string;
	viewer: SessionViewer;
	ip: string;
	openedAt: number;
} & (
	| { kind: 'terminal'; shell: TerminalShell }
	| { kind: 'files' }
	/** One machine's part of a command run (SPEC-COMMANDS); the server is its other end. */
	| { kind: 'exec'; shell: TerminalShell; runId: string }
	| { kind: 'desktop'; mode: DesktopMode }
);

/** The server's own end of a session, in the browser's place (file and exec sessions). */
export type LocalEnd = {
	/** The agent's socket is open: requests can go. */
	ready(): void;
	/** A text frame from the agent that is not its last word. */
	text(text: string): void;
	bytes(data: Uint8Array): void;
};

/** One copy or paste the agent confirmed (SPEC-DESKTOP 21.6). */
export type ClipboardTransfer = {
	direction: 'to-machine' | 'from-machine';
	bytes: number;
	at: number;
};

/** Clipboard sharing's transfers in one desktop session, per direction (SPEC-DESKTOP 21.11). */
export type SharedClipboard = Record<
	ClipboardTransfer['direction'],
	{ transfers: number; bytes: number }
>;

export type EndedSession = SessionRecord & {
	reason: SessionEndReason;
	message: string;
	endedAt: number;
	/** Bytes from the machine to the browser, and typed in the browser. */
	bytesOut: number;
	bytesIn: number;
	sharedClipboard: SharedClipboard;
};
