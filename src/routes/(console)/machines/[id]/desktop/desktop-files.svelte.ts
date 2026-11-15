import { showToast } from '#lib/ui/toast.svelte.ts';
import { attachDropZone } from './drop-guard.ts';
import { sessionFilesApi } from './session-files-api.ts';
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

export class DesktopFiles {
	readonly sender: SessionFileSender;
	/** The Transfers panel under the bar. */
	panelOpen = $state(false);
	readonly #block: () => SendBlock;
	readonly #sessionId: () => string | undefined;

	constructor(
		machineOf: () => { id: string; name: string },
		view: { block: () => SendBlock; sessionId: () => string | undefined }
	) {
		this.#block = view.block;
		this.#sessionId = view.sessionId;
		const machine = machineOf();
		this.sender = new SessionFileSender(sessionFilesApi(machine.id), machine.name, {
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

	togglePanel(): void {
		this.panelOpen = !this.panelOpen;
		if (this.panelOpen) {
			void this.sender.refreshRows();
		}
	}
}
