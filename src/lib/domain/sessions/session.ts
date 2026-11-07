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
	'agent-timeout'
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
	}
}

/** Someone using a machine right now (SPEC-SESSIONS T8). */
export type SessionInUse = { kind: 'terminal'; userName: string };

/** "terminal by Kim", for "In use: …". */
export function inUseLabel(sessions: readonly SessionInUse[]): string {
	return sessions.map((session) => `${session.kind} by ${session.userName}`).join(', ');
}
