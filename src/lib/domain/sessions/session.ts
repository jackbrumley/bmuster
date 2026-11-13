/**
 * Remote sessions (SPEC-SESSIONS), as the console sees them. Browser-safe.
 *
 * A session is a stream between one browser and one agent, relayed by the
 * server. On the browser's socket binary frames are the session's bytes
 * (keystrokes one way, terminal output the other) and text frames are JSON
 * control messages (below).
 */

/** The shells a terminal can start. The agent resolves each to a program. */
export const TERMINAL_SHELLS = ['bash', 'sh', 'zsh', 'powershell', 'cmd'] as const;

export type TerminalShell = (typeof TERMINAL_SHELLS)[number];

/** Browser to server. */
export type BrowserControl =
	| { type: 'resize'; cols: number; rows: number }
	/** The person ended the session. */
	| { type: 'end' };

/** Server to browser. */
export type ServerControl =
	/** The browser is connected; `resumed` means output replayed from before follows. */
	| { type: 'attached'; resumed: boolean }
	/** The agent's end of the session is open (input now reaches the shell). */
	| { type: 'ready' }
	| { type: 'ended'; reason: SessionEndReason; message: string };

export const SESSION_END_REASONS = [
	'closed',
	'exited',
	'failed',
	'refused',
	'idle',
	'no-browser',
	'agent-lost',
	'agent-timeout',
	'unused',
	// Written at server start for a session the restart cut off (SPEC-SESSIONS T9).
	'server-restarted',
	// Desktop sessions (SPEC-DESKTOP 9), as the agent reports them.
	'declined',
	'timed-out',
	'disconnected-at-machine',
	'permission-removed',
	'too-many-sessions',
	// SPEC-SHARE-LINKS: the link was ended, expired or its creator lost access.
	'share-link-ended'
] as const;

/** Why a session ended, as the audit log and the console say it. */
export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

export function endReasonLabel(reason: SessionEndReason): string {
	switch (reason) {
		case 'closed':
			return 'Ended from the console';
		case 'exited':
			return 'The shell exited';
		case 'failed':
			return 'The session could not run';
		case 'refused':
			return 'The agent refused it';
		case 'idle':
			return 'No input for 60 minutes';
		case 'no-browser':
			return 'No browser for 60 seconds';
		case 'agent-lost':
			return 'The connection to the machine was lost';
		case 'agent-timeout':
			return 'The machine did not answer';
		case 'unused':
			return 'Files not used for 5 minutes';
		case 'server-restarted':
			return 'The server restarted';
		case 'declined':
			return 'The person at the screen declined';
		case 'timed-out':
			return 'Nobody at the screen answered';
		case 'disconnected-at-machine':
			return 'Disconnected at the machine';
		case 'permission-removed':
			return 'The permission was removed';
		case 'too-many-sessions':
			return 'The machine already had 4 desktop sessions';
		case 'share-link-ended':
			return 'The share link ended';
	}
}

/**
 * How a desktop session can end, as the agent says in its last message
 * (`{type: 'ended', reason}`, SPEC-DESKTOP 5.2 and 9).
 */
export const DESKTOP_END_REASONS = [
	'closed',
	'declined',
	'timed-out',
	'disconnected-at-machine',
	'no-browser',
	'agent-lost',
	'permission-removed',
	'too-many-sessions'
] as const satisfies readonly SessionEndReason[];

/** Watch the screen only, or watch and control it (SPEC-DESKTOP R3). */
export const DESKTOP_MODES = ['watch', 'control'] as const;

export type DesktopMode = (typeof DESKTOP_MODES)[number];

/** Someone using a machine right now (SPEC-SESSIONS T8, SPEC-DESKTOP R17). */
export type SessionInUse =
	| { kind: 'terminal' | 'files' | 'command'; userName: string }
	| { kind: 'desktop'; mode: DesktopMode; userName: string };

/** "terminal by Kim", "desktop (control) by Kim", for "In use: …". */
export function inUseLabel(sessions: readonly SessionInUse[]): string {
	return sessions
		.map((session) => {
			switch (session.kind) {
				case 'terminal':
				case 'files':
				case 'command':
					return `${session.kind} by ${session.userName}`;
				case 'desktop':
					return `desktop (${session.mode}) by ${session.userName}`;
			}
		})
		.join(', ');
}
