import { displayChoices, type DisplayChoice } from '#lib/domain/desktop/displays.ts';
import type {
	DesktopSettings as PictureSettings,
	InputMessage
} from '#lib/domain/desktop/messages.ts';
import type { OsFamily } from '#lib/domain/machines/machine.ts';
import { copiedLabel } from '#lib/domain/session-files/session-files.ts';
import type { DesktopMode } from '#lib/domain/sessions/session.ts';
import type { Connection } from '#lib/runes/session-link.svelte.ts';
import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
import type { DesktopFiles } from './desktop-files.svelte.ts';
import type { DesktopSession } from './desktop-session.svelte.ts';
import {
	availableActions,
	connectionStatus,
	type ChromeAction,
	type SessionStatus
} from './session-actions.ts';
import { isRunning } from './stage-state.ts';
import type { TouchMode } from './touch-gestures.ts';
import { readTouchMode, saveTouchMode } from './touch-input.ts';

/**
 * The session's controls, one model for every desktop view (SPEC-DESKTOP
 * 23): what the session offers now, the open panel, the touch input
 * choice and the files-waiting notice. The tab's bar, the floating bar of
 * full screen and the pop-out, and the controls button's sheet all read
 * this, so they offer the same things.
 */

/** The machine as the controls need it. */
export type ChromeMachine = { name: string; osFamily: OsFamily; agentVersion: string };

/** The block under the bar: picture settings, the Keys menu or the clipboard, one at a time. */
export type ChromePanel = 'none' | 'settings' | 'keys' | 'clipboard';

/** Files copied on the machine, waiting to be downloaded. */
export type FilesWaiting = { text: string; download: { label: string; run: () => void } };

/** Where the session went when another window or tab took it, and what this view offers. */
export type MovedNotice =
	| { kind: 'elsewhere' }
	| { kind: 'popped-out'; closed: boolean; onbringback: () => void; onclose: () => void }
	| { kind: 'window'; onclose: () => void };

/** What leaves the floating layouts: full screen, or the pop-out window (SPEC-DESKTOP-POPOUT 9). */
export type ChromeExit = { kind: 'full-screen' | 'window'; run: () => void };

/** How a view lays out the controls (SPEC-DESKTOP 23.4, 2). */
export type ChromeLayout =
	| { kind: 'bar'; onfullscreen: () => void; onpopout: (() => void) | undefined }
	| { kind: 'phone'; onfullscreen: () => void }
	| { kind: 'overlay'; surface: HTMLElement; exit: ChromeExit }
	| { kind: 'floating'; exit: ChromeExit };

export class SessionChrome {
	/** The panel the person opened; shown only while its action is available. */
	open = $state<ChromePanel>('none');
	/** How a finger drives the pointer; remembered in this browser. */
	touchMode = $state<TouchMode>('trackpad');
	/** The offer whose notice the person put away. */
	#putAway = $state<string | undefined>(undefined);

	/** Files through the screen; undefined where files are never allowed (a share link). */
	readonly files: DesktopFiles | undefined;
	readonly #session: () => DesktopSession | undefined;
	readonly #canControl: () => boolean;
	readonly #machine: () => ChromeMachine;
	readonly #focusScreen: () => void;

	constructor(source: {
		session: () => DesktopSession | undefined;
		files: DesktopFiles | undefined;
		canControl: () => boolean;
		machine: () => ChromeMachine;
		/** Gives the keyboard back to the screen after an action. */
		focusScreen: () => void;
	}) {
		this.#session = source.session;
		this.files = source.files;
		this.#canControl = source.canControl;
		this.#machine = source.machine;
		this.#focusScreen = source.focusScreen;
	}

	get session(): DesktopSession | undefined {
		return this.#session();
	}

	get machine(): ChromeMachine {
		return this.#machine();
	}

	get canControl(): boolean {
		return this.#canControl();
	}

	get connection(): Connection {
		return this.session?.connection ?? { kind: 'idle' };
	}

	get running(): boolean {
		return isRunning(this.connection);
	}

	/** No session runs: the view offers its start instead of the screen. */
	get choosing(): boolean {
		return this.connection.kind === 'idle' || this.connection.kind === 'ended';
	}

	/** The running session's mode; undefined while none runs. */
	get mode(): DesktopMode | undefined {
		return this.running ? this.session?.mode : undefined;
	}

	get watchOnly(): boolean {
		return this.session?.mode === 'watch';
	}

	get status(): SessionStatus {
		return connectionStatus(this.connection, this.session?.throughput);
	}

	/** The screen picker: each display, and All screens when the agent can (SPEC-DESKTOP-ALL-SCREENS). */
	get displays(): DisplayChoice[] {
		return displayChoices(this.session?.displays ?? [], this.session?.allScreens ?? false);
	}

	get display(): string | null {
		return this.session?.current ?? null;
	}

	get download(): { label: string; run: () => void } | undefined {
		return this.files?.download;
	}

	/** What the session offers now; every layout shows these (SPEC-DESKTOP 23.4, 3). */
	get actions(): ChromeAction[] {
		return availableActions({
			running: this.running,
			watchOnly: this.watchOnly,
			canControl: this.canControl,
			canSend: this.files?.canSend === true,
			filesWaiting: this.download !== undefined,
			transfersOpen: this.files?.panelOpen === true,
			displays: this.displays.length
		});
	}

	has(action: ChromeAction): boolean {
		return this.actions.includes(action);
	}

	/** The panel shown now: the one opened, while it is still on offer. */
	get panel(): ChromePanel {
		switch (this.open) {
			case 'none':
				return 'none';
			case 'settings':
				return this.has('settings') ? 'settings' : 'none';
			case 'keys':
				return this.has('keys') ? 'keys' : 'none';
			case 'clipboard':
				return this.has('clipboard') ? 'clipboard' : 'none';
		}
	}

	get transfersOpen(): boolean {
		return this.files?.panelOpen === true;
	}

	/** Uploads still running, for the Transfers button's count. */
	get transfersRunning(): number {
		return this.files?.sender.running ?? 0;
	}

	/** The files-waiting notice (SPEC-DESKTOP 23.4, 4), until the person puts it away. */
	get waiting(): FilesWaiting | undefined {
		const offer = this.files?.offer;
		const download = this.download;
		if (offer?.kind !== 'offer' || download === undefined) {
			return undefined;
		}
		return { text: copiedLabel(offer), download };
	}

	/** The notice shows: files wait and the person has not put this copy's notice away. */
	get waitingNotice(): FilesWaiting | undefined {
		const offer = this.files?.offer;
		return offer?.kind === 'offer' && offer.offerId === this.#putAway ? undefined : this.waiting;
	}

	putAwayWaiting(): void {
		const offer = this.files?.offer;
		this.#putAway = offer?.kind === 'offer' ? offer.offerId : undefined;
	}

	toggle(panel: Exclude<ChromePanel, 'none'>): void {
		this.open = this.open === panel ? 'none' : panel;
	}

	toggleTransfers(): void {
		this.files?.togglePanel();
	}

	upload(): void {
		this.files?.pick();
	}

	/** Get copied files, for the Clipboard panel while sharing is off; undefined without files. */
	get getCopied(): (() => void) | undefined {
		return this.files?.sheet?.getCopied;
	}

	send(message: InputMessage): void {
		this.session?.input(message);
	}

	focusScreen(): void {
		this.#focusScreen();
	}

	switchMode(mode: DesktopMode): void {
		this.open = 'none';
		void this.session?.switchMode(mode);
	}

	selectDisplay(id: string): void {
		this.session?.selectDisplay(id);
	}

	changeSettings(settings: PictureSettings): void {
		this.session?.changeSettings(settings);
	}

	chooseTouchMode(mode: TouchMode): void {
		this.touchMode = mode;
		saveTouchMode(mode);
	}

	/** Reads what this browser remembers; once mounted, where storage exists. */
	restore(): void {
		this.touchMode = readTouchMode();
	}

	async disconnect(): Promise<void> {
		const yes = await confirmAction({
			title: 'Disconnect from this screen?',
			message: 'The session ends, and the notice on the machine goes away.',
			confirmLabel: 'Disconnect'
		});
		if (yes) {
			this.session?.end();
		}
	}
}
