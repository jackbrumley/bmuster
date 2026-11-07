import { TERMINAL_SHELLS, type TerminalShell } from '#lib/domain/sessions/session.ts';
import { SessionLink, type Connection } from '#lib/runes/session-link.svelte.ts';

/**
 * One terminal session as the page sees it (SPEC-SESSIONS T1, T4, T6): the
 * shared session link carries the socket and reattaching; binary frames
 * are the terminal's bytes, and the only control of its own is `resize`.
 */

export type { Connection };

/** Where the session's output goes. */
export type ScreenSink = {
	write(bytes: Uint8Array): void;
	reset(): void;
};

function isShell(text: string): text is TerminalShell {
	return TERMINAL_SHELLS.some((shell) => shell === text);
}

export class TerminalSession {
	/** The shell of the session this tab has, once one started. */
	shell = $state<TerminalShell | undefined>(undefined);

	readonly #link: SessionLink;
	readonly #screen: ScreenSink;
	readonly #encoder = new TextEncoder();
	#size = { cols: 0, rows: 0 };

	constructor(machineId: string, screen: ScreenSink) {
		this.#screen = screen;
		this.#link = new SessionLink('terminal', machineId, {
			attached: (resumed) => {
				if (resumed) {
					// The server replays recent output next; start from a clean screen.
					this.#screen.reset();
				}
				if (this.#size.cols > 0) {
					this.#resizeMessage();
				}
			},
			ready: () => undefined,
			binary: (data) => {
				this.#screen.write(data);
			},
			text: () => undefined,
			ended: () => undefined
		});
	}

	get connection(): Connection {
		return this.#link.connection;
	}

	/** Comes back to this tab's running session after a reload; false when there is none. */
	async resume(): Promise<boolean> {
		const tag = await this.#link.resume();
		if (tag === undefined) {
			return false;
		}
		this.shell = isShell(tag) ? tag : undefined;
		return true;
	}

	async start(shell: TerminalShell, cols: number, rows: number): Promise<void> {
		this.#size = { cols, rows };
		if (await this.#link.start({ kind: 'terminal', shell, cols, rows }, shell)) {
			this.shell = shell;
			this.#screen.reset();
		}
	}

	/** Typing (and the extra keys) as UTF-8. */
	send(data: string): void {
		this.#link.sendBytes(this.#encoder.encode(data));
	}

	resize(cols: number, rows: number): void {
		if (cols === this.#size.cols && rows === this.#size.rows) {
			return;
		}
		this.#size = { cols, rows };
		this.#resizeMessage();
	}

	/** Ends the session on the machine (the shell and everything it started). */
	end(): void {
		this.#link.end();
	}

	/** Takes the session back from another window. */
	async takeBack(): Promise<void> {
		await this.#link.takeBack();
	}

	/** The page is going away: let go of the socket, not the session (it can come back). */
	detach(): void {
		this.#link.detach();
	}

	#resizeMessage(): void {
		this.#link.sendText(
			JSON.stringify({ type: 'resize', cols: this.#size.cols, rows: this.#size.rows })
		);
	}
}
