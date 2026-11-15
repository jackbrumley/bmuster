import { resolve } from '$app/paths';
import { downloadLabel, type ClipboardOffer } from '#lib/domain/session-files/session-files.ts';
import { showToast } from '#lib/ui/toast.svelte.ts';
import { attachDropZone } from './drop-guard.ts';
import { sessionFilesApi, type SessionFilesApi } from './session-files-api.ts';
import { chosenFromDrop, SessionFileSender, type SendBlock } from './session-file-sender.svelte.ts';

/**
 * Files through the screen in one desktop view (SPEC-SESSION-FILES): the
 * stage as a drop zone, Upload files, and the Transfers panel, for the
 * Desktop tab and the pop-out window alike.
 */

/** Whether this view may send files now, and if not, the words why (SF14). */
export function sendBlock(view: {
	canFiles: boolean;
	canControl: boolean;
	running: boolean;
	watchOnly: boolean;
}): SendBlock {
	if (!view.canFiles || !view.canControl) {
		return {
			kind: 'blocked',
			message:
				"You don't have permission to send files to this machine. That needs Files and Control desktop."
		};
	}
	if (!view.running) {
		return { kind: 'blocked', message: 'Connect to the screen first.' };
	}
	if (view.watchOnly) {
		return {
			kind: 'blocked',
			message: 'This session only watches. Take control to send files.'
		};
	}
	return { kind: 'none' };
}

/** Files in the full-screen controls: Upload files, and Download N files when there is an offer. */
export type SheetFiles = {
	upload: () => void;
	download: { label: string; run: () => void } | undefined;
	/** Get copied files, for the Clipboard tab while sharing is off. */
	getCopied: () => void;
};

/** The Transfers panel in the full-screen sheet's Session tab. */
export type SheetTransfers = {
	open: boolean;
	/** Uploads still running, for the button's count. */
	running: number;
	toggle: () => void;
	sender: SessionFileSender;
};

export class DesktopFiles {
	readonly sender: SessionFileSender;
	/** The Transfers panel under the bar. */
	panelOpen = $state(false);
	/** What is copied on the machine now (SPEC-SESSION-FILES 3.2). */
	offer = $state<ClipboardOffer>({ kind: 'none' });
	readonly #block: () => SendBlock;
	readonly #sessionId: () => string | undefined;
	readonly #sharing: () => boolean;
	readonly #api: SessionFilesApi;
	/** Looks in a row that failed; the watch waits longer after each (SF27, quiet when stuck). */
	#failedLooks = 0;
	/** The watch's next look, in `Date.now()` time. */
	#nextLookAt = 0;
	readonly #machineId: string;

	constructor(
		machineOf: () => { id: string; name: string },
		view: {
			block: () => SendBlock;
			sessionId: () => string | undefined;
			/** Share clipboard is on: copied files are offered by themselves, sent ones go on the clipboard. */
			sharing: () => boolean;
		}
	) {
		this.#block = view.block;
		this.#sessionId = view.sessionId;
		this.#sharing = view.sharing;
		const machine = machineOf();
		this.#machineId = machine.id;
		this.#api = sessionFilesApi(machine.id);
		this.sender = new SessionFileSender(this.#api, machine.name, view.sharing, {
			notify: (tone, text) => {
				showToast(text, tone);
			},
			wait: (ms) =>
				new Promise((resolve) => {
					setTimeout(resolve, ms);
				})
		});
	}

	/** Sending is allowed now: Upload files shows. */
	get canSend(): boolean {
		return this.#block().kind === 'none';
	}

	/** Makes the stage the drop zone. */
	attach(stage: HTMLElement): () => void {
		return attachDropZone(stage, {
			enter: () => void this.sender.enter(this.#block(), this.#sessionId()),
			leave: () => {
				this.sender.leave();
			},
			drop: (transfer) => {
				void this.sender.send(chosenFromDrop(transfer), this.#block(), this.#sessionId());
			},
			accepting: () => this.#block().kind === 'none'
		});
	}

	/** Upload files: the browser's own picker, several files, no folders. */
	pick(): void {
		const picker = document.createElement('input');
		picker.type = 'file';
		picker.multiple = true;
		picker.addEventListener('change', () => {
			const files = [...(picker.files ?? [])].map((file) => ({ file, isFolder: false }));
			void this.sender.send(files, this.#block(), this.#sessionId());
		});
		picker.click();
	}

	/** Asks what is copied on the machine; `quiet` keeps refusals out of the notices. */
	async look(quiet: boolean): Promise<void> {
		const sessionId = this.#sessionId();
		if (sessionId === undefined || !this.canSend) {
			this.offer = { kind: 'none' };
			return;
		}
		const answer = await this.#api.offer(sessionId);
		if (!answer.ok || answer.data.kind === 'refused') {
			this.#failedLooks += 1;
		} else {
			this.#failedLooks = 0;
		}
		this.#nextLookAt = Date.now() + lookDelayMs(this.#failedLooks);
		if (!answer.ok) {
			if (!quiet) {
				showToast(answer.message, 'error');
			}
			return;
		}
		this.offer = answer.data;
		if (!quiet && answer.data.kind !== 'offer') {
			showToast(
				answer.data.kind === 'refused'
					? answer.data.message
					: 'No files are copied on the machine. Copy them in its file manager first.',
				'error'
			);
		}
	}

	/**
	 * While Share clipboard is on, looks every `everyMs` (SF27); Get copied files asks once when
	 * it is off. Returns the stop.
	 */
	watch(everyMs: number): () => void {
		const tick = (): void => {
			if (this.#sharing() && this.canSend) {
				// A refusal (the machine's desktop has gone, files not allowed) backs off, so a broken
				// session doesn't open a refused files channel every couple of seconds.
				if (Date.now() >= this.#nextLookAt) {
					this.#nextLookAt = Date.now() + lookDelayMs(this.#failedLooks) + everyMs;
					void this.look(true);
				}
			} else if (this.offer.kind !== 'none' && !this.canSend) {
				this.offer = { kind: 'none' };
			}
		};
		tick();
		const timer = setInterval(tick, everyMs);
		return () => {
			clearInterval(timer);
		};
	}

	/** Download N files: the browser's own download, from the server's stream. */
	get download(): { label: string; run: () => void } | undefined {
		const offer = this.offer;
		const sessionId = this.#sessionId();
		if (offer.kind !== 'offer' || sessionId === undefined || !this.canSend) {
			return undefined;
		}
		const url = `${resolve('/api/machines/[id]/session-files/offers/[offerId]/download', {
			id: this.#machineId,
			offerId: offer.offerId
		})}?desktopSessionId=${encodeURIComponent(sessionId)}`;
		return {
			label: downloadLabel(offer),
			run: () => {
				const link = document.createElement('a');
				link.href = url;
				link.download = '';
				link.click();
			}
		};
	}

	/** The Transfers panel for the sheet, while sending is allowed or the panel is open. */
	get sheetTransfers(): SheetTransfers | undefined {
		if (!this.canSend && !this.panelOpen) {
			return undefined;
		}
		return {
			open: this.panelOpen,
			running: this.sender.running,
			toggle: () => {
				this.togglePanel();
			},
			sender: this.sender
		};
	}

	/** What the full-screen bar and sheet offer, while sending is allowed. */
	get sheet(): SheetFiles | undefined {
		return this.canSend
			? {
					upload: () => {
						this.pick();
					},
					download: this.download,
					getCopied: () => {
						void this.look(false);
					}
				}
			: undefined;
	}

	togglePanel(): void {
		this.panelOpen = !this.panelOpen;
		if (this.panelOpen) {
			void this.sender.refreshRows();
		}
	}
}

/** How long the watch waits after `failed` refused looks in a row: none, then 4 s doubling to 60 s. */
export function lookDelayMs(failed: number): number {
	return failed === 0 ? 0 : Math.min(60_000, 2_000 * 2 ** failed);
}
