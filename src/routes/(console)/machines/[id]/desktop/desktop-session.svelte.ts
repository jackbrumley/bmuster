import {
	FLAG_KEYFRAME,
	FLAG_LAST_PART,
	parseFrame,
	type FrameHeader,
	type Tile
} from '#lib/domain/desktop/frame.ts';
import {
	DEFAULT_DESKTOP_SETTINGS,
	type DesktopSettings,
	type InputMessage,
	type ViewerMessage
} from '#lib/domain/desktop/messages.ts';
import type { DesktopScreen } from '#lib/domain/desktop/screen.ts';
import { DESKTOP_MODES, type DesktopMode } from '#lib/domain/sessions/session.ts';
import { SessionLink, type Connection } from '#lib/runes/session-link.svelte.ts';
import { agentDesktopMessageSchema, type DesktopDisplay } from '#lib/schemas/desktop/desktop.ts';
import type { DesktopCanvas } from './desktop-canvas.ts';

/**
 * One desktop session as the page sees it (SPEC-DESKTOP): the shared session
 * link carries the socket and reattaching; this reads the agent's frames
 * and messages, draws, acknowledges, and sends the viewer's input. A
 * watch-only session never sends input at all.
 */

/** Frames and bytes over the last second, for the status line. */
export type Throughput = { fps: number; bytesPerSecond: number };

function isMode(text: string): text is DesktopMode {
	return DESKTOP_MODES.some((mode) => mode === text);
}

/** The frame after `seq`, wrapping at 32 bits. */
function nextSeq(seq: number): number {
	return (seq + 1) % 0x1_0000_0000;
}

export class DesktopSession {
	mode = $state<DesktopMode | undefined>(undefined);
	displays = $state<DesktopDisplay[]>([]);
	current = $state<string | undefined>(undefined);
	/** What the screen at the machine shows; the agent says so after hello and on every change. */
	screen = $state<DesktopScreen | undefined>(undefined);
	/** The agent paused frames because no acknowledgement came for 10 s (4.3). */
	stalled = $state(false);
	/** The agent's last error, for the person to read. */
	problem = $state<string | undefined>(undefined);
	throughput = $state<Throughput>({ fps: 0, bytesPerSecond: 0 });
	/** The stream's frame size; undefined before the first frame. */
	frameSize = $state<{ width: number; height: number } | undefined>(undefined);
	settings = $state<DesktopSettings>({ ...DEFAULT_DESKTOP_SETTINGS });

	readonly #link: SessionLink;
	readonly #canvas: DesktopCanvas;
	readonly #viewport: () => { width: number; height: number; pixelRatio: number };
	/** Batches of the frame being received; drawn when its last part comes. */
	#parts: { seq: number; tiles: Tile[] } | undefined;
	#lastDrawn: number | undefined;
	#drawing: Promise<void> = Promise.resolve();
	#frames = 0;
	#bytes = 0;
	#clock: ReturnType<typeof setInterval> | undefined;
	#approvalTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		machineId: string,
		canvas: DesktopCanvas,
		viewport: () => { width: number; height: number; pixelRatio: number }
	) {
		this.#canvas = canvas;
		this.#viewport = viewport;
		this.#link = new SessionLink('desktop', machineId, {
			attached: () => undefined,
			ready: () => {
				this.#greet();
			},
			binary: (data) => {
				this.#onBinary(data);
			},
			text: (text) => {
				this.#onText(text);
			},
			ended: () => {
				this.#clearApprovalTimer();
				// The next session is a fresh choice: only a reattach keeps the mode.
				this.mode = undefined;
				this.screen = undefined;
				this.#stopClock();
			}
		});
	}

	askApproval(): void {
		if (this.screen?.kind !== 'approval' || this.screen.phase === 'pending') {
			return;
		}
		this.#clearApprovalTimer();
		const requestMessage = 'Requesting approval on the machine…';
		this.screen = { kind: 'approval', phase: 'pending', message: requestMessage };
		this.#send({ type: 'ask-approval' });
		this.#approvalTimer = setTimeout(() => {
			if (this.screen?.kind === 'approval' && this.screen.message === requestMessage) {
				this.screen = {
					kind: 'approval',
					phase: 'declined',
					message: 'The agent did not respond. Refresh agent diagnostics in Manage and try again.'
				};
			}
			this.#approvalTimer = undefined;
		}, 15_000);
	}

	get connection(): Connection {
		return this.#link.connection;
	}

	/** True when this viewer may send input: a control session whose machine end is open. */
	get controlling(): boolean {
		const connection = this.#link.connection;
		return this.mode === 'control' && connection.kind === 'live' && connection.ready;
	}

	/** Comes back to this tab's running session after a reload; false when there is none. */
	async resume(): Promise<boolean> {
		const tag = await this.#link.resume();
		if (tag === undefined) {
			return false;
		}
		this.mode = isMode(tag) ? tag : 'watch';
		this.#startClock();
		return true;
	}

	async start(mode: DesktopMode): Promise<void> {
		this.#clearApprovalTimer();
		this.problem = undefined;
		this.stalled = false;
		this.screen = undefined;
		if (await this.#link.start({ kind: 'desktop', mode }, mode)) {
			this.mode = mode;
			this.#startClock();
		}
	}

	/**
	 * Watch only to control and back. A ticket carries its permissions, so a
	 * new mode is a new session: this one ends, and one in the new mode opens.
	 */
	async switchMode(mode: DesktopMode): Promise<void> {
		if (mode === this.mode) {
			return;
		}
		this.end();
		await this.start(mode);
	}

	/** Input from the viewer; dropped unless this session controls (SPEC-DESKTOP 7). */
	input(message: InputMessage): void {
		if (this.controlling) {
			this.#send(message);
		}
	}

	/** Asks for a whole new frame (after a gap, or to resume after a stall). */
	requestKeyframe(): void {
		this.stalled = false;
		this.#send({ type: 'keyframe' });
	}

	selectDisplay(id: string): void {
		if (id === this.current) {
			return;
		}
		this.input({ type: 'release-all' });
		this.#send({ type: 'select-display', display: id });
	}

	changeSettings(settings: DesktopSettings): void {
		this.settings = settings;
		this.#send({ type: 'settings', ...settings });
	}

	/** The viewer's screen changed size (full screen, rotation): the stream fits it again. */
	viewportChanged(): void {
		if (this.#link.connection.kind === 'live' && this.#link.connection.ready) {
			this.#greet();
		}
	}

	/** Ends the session on the machine. */
	end(): void {
		this.input({ type: 'release-all' });
		this.#link.end();
	}

	async takeBack(): Promise<void> {
		await this.#link.takeBack();
	}

	/** The page is going away: keys up, let go of the socket, not the session. */
	detach(): void {
		this.input({ type: 'release-all' });
		this.#stopClock();
		this.#clearApprovalTimer();
		this.#link.detach();
	}

	#send(message: ViewerMessage): void {
		this.#link.sendText(JSON.stringify(message));
	}

	/** `hello` on every (re)attach, then the settings; the agent answers with a keyframe. */
	#greet(): void {
		this.#parts = undefined;
		this.#lastDrawn = undefined;
		this.#canvas.forgetCursor();
		this.#send({ type: 'hello', codecs: ['jpeg'], viewport: this.#viewport() });
		this.#send({ type: 'settings', ...this.settings });
		this.#send({ type: 'keyframe' });
	}

	#startClock(): void {
		this.#stopClock();
		this.#clock = setInterval(() => {
			this.throughput = { fps: this.#frames, bytesPerSecond: this.#bytes };
			this.#frames = 0;
			this.#bytes = 0;
		}, 1000);
	}

	#stopClock(): void {
		clearInterval(this.#clock);
		this.#clock = undefined;
		this.throughput = { fps: 0, bytesPerSecond: 0 };
	}

	#clearApprovalTimer(): void {
		clearTimeout(this.#approvalTimer);
		this.#approvalTimer = undefined;
	}

	#onText(text: string): void {
		this.#bytes += text.length;
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			return;
		}
		const parsed = agentDesktopMessageSchema.safeParse(json);
		if (!parsed.success) {
			return;
		}
		const message = parsed.data;
		switch (message.type) {
			case 'displays':
				this.displays = message.list;
				this.current = message.current;
				return;
			case 'stream':
				return;
			case 'state':
				this.#clearApprovalTimer();
				this.screen = message.screen;
				return;
			case 'stalled':
				this.stalled = true;
				return;
			case 'error':
				this.#clearApprovalTimer();
				if (this.screen?.kind === 'approval' && this.screen.phase === 'pending') {
					this.screen = { kind: 'approval', phase: 'declined', message: message.message };
				}
				this.problem = message.message;
				return;
		}
	}

	#onBinary(data: Uint8Array): void {
		this.#bytes += data.byteLength;
		const parsed = parseFrame(data);
		if (parsed.kind === 'bad') {
			if (parsed.wrongVersion) {
				this.problem = parsed.message;
				this.#send({ type: 'disconnect' });
			}
			return;
		}
		const frame = parsed.frame;
		switch (frame.kind) {
			case 'h264':
				// Phase 2; this console offers JPEG only, so none should come.
				return;
			case 'cursor-shape':
				void this.#canvas.cursorShape(frame.id, frame.hotspotX, frame.hotspotY, frame.png);
				return;
			case 'cursor-position':
				this.#canvas.cursorPosition(frame.id, frame.x, frame.y, frame.visible);
				return;
			case 'tiles':
				this.#onTiles(frame.header, frame.tiles);
				return;
		}
	}

	#onTiles(header: FrameHeader, tiles: Tile[]): void {
		const { seq, flags } = header;
		if (this.#parts !== undefined && this.#parts.seq !== seq) {
			// The rest of the last frame never came: start again from a whole one.
			this.#parts = undefined;
			this.requestKeyframe();
		}
		const parts = this.#parts ?? { seq, tiles: [] };
		parts.tiles.push(...tiles);
		this.#parts = parts;
		if ((flags & FLAG_LAST_PART) === 0) {
			return;
		}
		this.#parts = undefined;
		const keyframe = (flags & FLAG_KEYFRAME) !== 0;
		if (!keyframe && this.#lastDrawn !== undefined && seq !== nextSeq(this.#lastDrawn)) {
			this.requestKeyframe();
		}
		this.#lastDrawn = seq;
		this.stalled = false;
		this.#drawing = this.#drawing
			.then(() => this.#canvas.draw(header, parts.tiles))
			.then(
				() => {
					this.#frames += 1;
					this.frameSize = { width: header.width, height: header.height };
				},
				() => {
					// A tile that would not decode: draw everything again.
					this.requestKeyframe();
				}
			)
			.then(() => {
				this.#send({ type: 'ack', seq });
			});
	}
}
