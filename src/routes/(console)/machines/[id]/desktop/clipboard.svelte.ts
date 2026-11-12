import { MAX_CLIPBOARD_BYTES, type ViewerMessage } from '#lib/domain/desktop/messages.ts';
import { showToast } from '#lib/ui/toast.svelte.ts';
import { copyText, readGranted, readText } from '#lib/utils/clipboard.ts';

/**
 * Copy and paste for one desktop session (SPEC-DESKTOP 21): the panel's text
 * box, what it waits for from the agent, and what to tell the person. Text
 * only, at most 1 MiB of UTF-8 each way. The session hands it the agent's
 * clipboard replies; nothing here is ever logged or kept after the page.
 *
 * Clipboard sharing (21.11), on by default in a control session: text the
 * machine copies is written to this device's clipboard by itself (or on the
 * next tap or key press, where the browser needs one), and on desktop
 * browsers that already allow reading the clipboard, this device's text goes
 * to the machine whenever the page comes back into focus.
 */

/** A message the panel shows under its buttons. */
export type ClipboardNote =
	{ kind: 'none' } | { kind: 'info'; message: string } | { kind: 'error'; message: string };

/** What the clipboard sends to the agent. */
type ClipboardRequest = Extract<
	ViewerMessage,
	{ type: 'clipboard-push' | 'clipboard-pull' | 'clipboard-share' | 'clipboard-sync' }
>;

/** What the phone keyboard's paste says once the text is on the machine (SPEC-DESKTOP 21.11). */
export const READY_TO_PASTE = 'Ready to paste on the machine — right-click → Paste or Ctrl+V';
/** What a machine copy says when it lands on this device after a tap. */
export const COPIED_FROM_MACHINE = 'Copied from the machine';

/** An agent from before copy and paste drops both requests: say so after this long. */
export const CLIPBOARD_REPLY_MS = 10_000;
/** Ctrl+V waits this long for the push before sending the key anyway. */
export const SHORTCUT_PUSH_MS = 2_000;

const encoder = new TextEncoder();

/** The text's length in UTF-8 bytes, as the agent counts it. */
function utf8Bytes(text: string): number {
	return encoder.encode(text).byteLength;
}

/** Plain words for "more than 1 MB" in the panel. */
const TOO_LONG = `The text is over ${MAX_CLIPBOARD_BYTES / (1024 * 1024)} MB. Copy and paste carries at most 1 MB at a time.`;

export class DesktopClipboard {
	/** The panel's text box. */
	text = $state('');
	/** The request waiting for the agent's answer. */
	waiting = $state<'none' | 'pull' | 'push'>('none');
	note = $state<ClipboardNote>({ kind: 'none' });
	/** The box is too long to send; the field shows why. */
	readonly tooLong = $derived(utf8Bytes(this.text) > MAX_CLIPBOARD_BYTES);
	readonly fieldError = $derived(this.tooLong ? TOO_LONG : undefined);

	/** The latest text the machine copied, shown with Copy to phone (SPEC-DESKTOP 21.11). */
	latest = $state('');
	/** Text from the machine the browser would not write yet; written on the next tap or key. */
	pending = $state<string | undefined>(undefined);
	/** This browser lets the page read its clipboard without asking (desktop, after one Allow). */
	readAllowed = $state(false);

	readonly #send: (message: ClipboardRequest) => void;
	#timer: ReturnType<typeof setTimeout> | undefined;
	/** Ctrl+V pushes waiting for the agent's answer: true once it is on the machine. */
	#pushed: ((ok: boolean) => void)[] = [];
	#sharing = $state(true);
	/** A control session is running: sharing messages reach an agent that answers them. */
	#live = false;
	/** The last text that went either way, so neither side gets its own text back. */
	#lastShared: string | undefined;
	/** The phone keyboard's paste is waiting: its confirmation shows the ready toast. */
	#keyboardPaste = false;

	constructor(send: (message: ClipboardRequest) => void) {
		this.#send = send;
	}

	/** Share clipboard, the session's one switch: off stops both directions. */
	get sharing(): boolean {
		return this.#sharing;
	}

	set sharing(on: boolean) {
		this.#sharing = on;
		if (!on) {
			this.pending = undefined;
		}
		if (this.#live) {
			this.#send({ type: 'clipboard-share', on });
		}
	}

	/** A control session started or reattached: tell the agent the switch, then catch up. */
	started(): void {
		this.#live = true;
		this.#send({ type: 'clipboard-share', on: this.#sharing });
		void readGranted().then((granted) => {
			this.readAllowed = granted;
		});
	}

	/** The agent's `clipboard-changed`: write it here now if the browser lets us, else on the next tap. */
	async changed(text: string): Promise<void> {
		if (!this.#sharing) {
			return;
		}
		this.latest = text;
		this.#lastShared = text;
		this.pending = text;
		if (document.hasFocus()) {
			const copied = await copyText(text);
			if (copied.ok && this.pending === text) {
				this.pending = undefined;
			}
		}
	}

	/** A tap or key press in the page: the browser now lets us write a machine copy that waited. */
	async landPending(): Promise<void> {
		const text = this.pending;
		if (text === undefined) {
			return;
		}
		const copied = await copyText(text);
		if (copied.ok && this.pending === text) {
			this.pending = undefined;
			showToast(COPIED_FROM_MACHINE, 'success');
		}
	}

	/**
	 * The page came back into focus: on a browser that already allows reading the clipboard,
	 * send this device's text to the machine if it is new. Never asks for the permission.
	 */
	async syncFromDevice(): Promise<void> {
		if (!this.#sharing || !this.#live) {
			return;
		}
		this.readAllowed = await readGranted();
		if (!this.readAllowed) {
			return;
		}
		const read = await readText();
		if (!read.ok) {
			return;
		}
		this.#sync(read.text);
	}

	/**
	 * Allow clipboard sharing, a button press: reading now lets the browser ask once, and from
	 * then on focus brings this device's text to the machine by itself.
	 */
	async allowSharing(): Promise<void> {
		const read = await readText();
		this.readAllowed = await readGranted();
		if (!read.ok) {
			this.note = {
				kind: 'error',
				message:
					"This browser did not allow reading its clipboard, so copies here won't reach the machine by themselves. Use the box below instead."
			};
			return;
		}
		this.note = { kind: 'info', message: 'Clipboard sharing is on for this browser.' };
		this.#sync(read.text);
	}

	/**
	 * The phone keyboard pasted (its clipboard chip, or long-press Paste): the text goes to the
	 * machine's clipboard rather than being typed, ready to paste there.
	 */
	pasteFromKeyboard(text: string): void {
		if (text === '') {
			return;
		}
		if (utf8Bytes(text) > MAX_CLIPBOARD_BYTES) {
			showToast(TOO_LONG, 'error');
			return;
		}
		this.#lastShared = text;
		this.#keyboardPaste = true;
		this.#ask('push', { type: 'clipboard-push', text });
	}

	#sync(text: string): void {
		if (text === '' || text === this.#lastShared || utf8Bytes(text) > MAX_CLIPBOARD_BYTES) {
			return;
		}
		this.#lastShared = text;
		this.#send({ type: 'clipboard-sync', text });
	}

	/** Asks for the machine's clipboard; the reply fills the box. */
	pull(): void {
		this.#ask('pull', { type: 'clipboard-pull' });
	}

	/** Sends the box to the machine's clipboard, unless it is too long. */
	push(): void {
		if (this.tooLong) {
			return;
		}
		this.#lastShared = this.text;
		this.#ask('push', { type: 'clipboard-push', text: this.text });
	}

	/** The agent's `clipboard` reply. */
	received(text: string): void {
		this.#settle();
		this.text = text;
		this.#lastShared = text;
		this.note =
			text === ''
				? { kind: 'info', message: "The machine's clipboard has no text." }
				: { kind: 'info', message: "Got the machine's clipboard." };
	}

	/** The agent's `clipboard-sent`. */
	sent(): void {
		this.#settle();
		this.note = { kind: 'info', message: "Sent to the machine's clipboard." };
		this.#answerPushes(true);
		if (this.#keyboardPaste) {
			this.#keyboardPaste = false;
			showToast(READY_TO_PASTE, 'success');
		}
	}

	/** The agent's `clipboard-failed`, with its reason. */
	failed(message: string): void {
		this.#settle();
		this.note = { kind: 'error', message };
		this.#answerPushes(false);
		if (this.#keyboardPaste) {
			this.#keyboardPaste = false;
			showToast(message, 'error');
		}
	}

	/** Puts the box on this device's clipboard. */
	async copyToDevice(): Promise<void> {
		const copied = await copyText(this.text);
		this.note = copied.ok
			? { kind: 'info', message: 'Copied to this device.' }
			: { kind: 'error', message: `This browser did not allow copying: ${copied.reason}.` };
	}

	/** Fills the box from this device's clipboard, or says why the browser would not. */
	async pasteFromDevice(): Promise<void> {
		const pasted = await readText();
		if (!pasted.ok) {
			this.note = {
				kind: 'error',
				message:
					'This browser did not allow reading its clipboard. Paste into the box with your keys instead.'
			};
			return;
		}
		this.text = pasted.text;
		this.note = { kind: 'none' };
	}

	/**
	 * Ctrl+V on the picture: this device's clipboard to the machine's, then
	 * true once the agent has it. False when the browser would not read it,
	 * the text is too long, or the machine refused or did not answer in time.
	 */
	async pushFromDevice(): Promise<boolean> {
		const pasted = await readText();
		if (!pasted.ok || utf8Bytes(pasted.text) > MAX_CLIPBOARD_BYTES) {
			return false;
		}
		return new Promise((resolve) => {
			const done = (ok: boolean) => {
				clearTimeout(timer);
				this.#pushed = this.#pushed.filter((waiter) => waiter !== done);
				resolve(ok);
			};
			const timer = setTimeout(() => {
				done(false);
			}, SHORTCUT_PUSH_MS);
			this.#pushed.push(done);
			this.#lastShared = pasted.text;
			this.#send({ type: 'clipboard-push', text: pasted.text });
		});
	}

	/** The session ended or the page is going: stop waiting. */
	stop(): void {
		this.#settle();
		this.#answerPushes(false);
		this.#live = false;
		this.#keyboardPaste = false;
		this.pending = undefined;
	}

	#ask(waiting: 'pull' | 'push', message: ClipboardRequest): void {
		this.#settle();
		this.waiting = waiting;
		this.note = { kind: 'none' };
		this.#send(message);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			this.waiting = 'none';
			this.note = {
				kind: 'error',
				message:
					'The machine did not answer. Its agent may be too old for copy and paste: update it from Manage.'
			};
		}, CLIPBOARD_REPLY_MS);
	}

	#settle(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.waiting = 'none';
	}

	#answerPushes(ok: boolean): void {
		for (const answer of this.#pushed.splice(0)) {
			answer(ok);
		}
	}
}

/**
 * Clipboard sharing in the page (SPEC-DESKTOP 21.11): when the window comes back into focus or
 * the tab back into view, this device's clipboard goes to the machine (where the browser already
 * allows it); a tap or key press anywhere in the page lands a machine copy the browser held back.
 * Returns the detach function.
 */
export function attachClipboardSharing(clipboard: DesktopClipboard): () => void {
	const sync = () => {
		void clipboard.syncFromDevice();
	};
	const visible = () => {
		if (document.visibilityState === 'visible') {
			sync();
		}
	};
	const land = () => {
		void clipboard.landPending();
	};
	window.addEventListener('focus', sync);
	document.addEventListener('visibilitychange', visible);
	window.addEventListener('pointerdown', land, { capture: true });
	window.addEventListener('keydown', land, { capture: true });
	return () => {
		window.removeEventListener('focus', sync);
		document.removeEventListener('visibilitychange', visible);
		window.removeEventListener('pointerdown', land, { capture: true });
		window.removeEventListener('keydown', land, { capture: true });
	};
}

/** Ctrl+V and nothing else: no Alt (AltGr), Shift or Meta, not a repeat. */
function isPasteChord(event: KeyboardEvent): boolean {
	return (
		event.code === 'KeyV' &&
		event.ctrlKey &&
		!event.altKey &&
		!event.shiftKey &&
		!event.metaKey &&
		!event.repeat
	);
}

function isControl(code: string): boolean {
	return code === 'ControlLeft' || code === 'ControlRight';
}

/**
 * Ctrl+V on the picture with clipboard reading already granted (SPEC-DESKTOP
 * 21.2): pushes this device's clipboard to the machine, then sends Ctrl+V,
 * so the machine pastes what the viewer copied. Without the permission the
 * key goes on to the screen's own input untouched. Listens in the capture
 * phase so it decides before the screen's key handler sees the key. Returns
 * the detach function.
 */
export function attachPasteShortcut(
	surface: HTMLElement,
	host: {
		clipboard: DesktopClipboard;
		send: (message: Extract<ViewerMessage, { type: 'key' }>) => void;
		controlling: () => boolean;
		/** Whether the browser already lets the page read its clipboard (`readGranted`). */
		readAllowed: () => Promise<boolean>;
	}
): () => void {
	let granted = false;
	let controlHeld = false;
	/** The V key's release that belongs to a handled Ctrl+V. */
	let swallowRelease = false;
	const refresh = () => {
		void host.readAllowed().then((answer) => {
			granted = answer;
		});
	};
	const key = (code: string, key: string, down: boolean) => {
		host.send({ type: 'key', code, key, down, altGr: false });
	};
	const paste = async () => {
		await host.clipboard.pushFromDevice();
		// The screen's input already sent Ctrl down; let go meanwhile, press it for the paste.
		const pressControl = !controlHeld;
		if (pressControl) {
			key('ControlLeft', 'Control', true);
		}
		key('KeyV', 'v', true);
		key('KeyV', 'v', false);
		if (pressControl) {
			key('ControlLeft', 'Control', false);
		}
	};
	const onKeyDown = (event: KeyboardEvent) => {
		if (isControl(event.code)) {
			controlHeld = true;
		}
		if (event.target !== surface || !granted || !host.controlling() || !isPasteChord(event)) {
			return;
		}
		event.preventDefault();
		event.stopImmediatePropagation();
		swallowRelease = true;
		void paste();
	};
	const onKeyUp = (event: KeyboardEvent) => {
		if (isControl(event.code)) {
			controlHeld = false;
		}
		if (swallowRelease && event.code === 'KeyV') {
			swallowRelease = false;
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	};
	refresh();
	surface.addEventListener('focus', refresh);
	surface.addEventListener('keydown', onKeyDown, { capture: true });
	surface.addEventListener('keyup', onKeyUp, { capture: true });
	return () => {
		surface.removeEventListener('focus', refresh);
		surface.removeEventListener('keydown', onKeyDown, { capture: true });
		surface.removeEventListener('keyup', onKeyUp, { capture: true });
	};
}
