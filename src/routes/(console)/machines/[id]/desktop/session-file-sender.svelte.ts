import { SvelteSet } from 'svelte/reactivity';
import {
	dropProblem,
	sentNotice,
	type SendTarget,
	type TransferRow
} from '#lib/domain/session-files/session-files.ts';
import { UploadQueue, type SessionDestination, type Upload } from '../files/upload-queue.svelte.ts';
import type { SessionFilesApi } from './session-files-api.ts';

/**
 * Sending files through a desktop session (SPEC-SESSION-FILES 3.1): what the
 * drop overlay says, the drops themselves (one after another, through the
 * Files tab's upload queue), the browser notice when a drop is over, and the
 * Transfers panel's rows.
 */

/** Why sending is not possible in this view, or nothing. */
export type SendBlock = { kind: 'none' } | { kind: 'blocked'; message: string };

/** The overlay while files are dragged over the screen. */
export type Overlay =
	| { kind: 'hidden' }
	| { kind: 'checking' }
	| { kind: 'ready'; user: string; folderLabel: string }
	| { kind: 'refused'; message: string };

/** One file the person chose or dropped. */
export type Chosen = { file: File; isFolder: boolean };

const SETTLED = ['done', 'failed', 'cancelled'];

export type SenderHooks = {
	/** Shows the browser notice. */
	notify: (tone: 'success' | 'error', text: string) => void;
	/** Waits between looks at a running drop; tests make it short. */
	wait: (ms: number) => Promise<void>;
};

export class SessionFileSender {
	readonly queue: UploadQueue<SessionDestination>;
	overlay = $state<Overlay>({ kind: 'hidden' });
	/** The Transfers panel's rows from the server (they survive a reload). */
	rows = $state<TransferRow[]>([]);
	readonly #api: SessionFilesApi;
	readonly #machineName: string;
	readonly #hooks: SenderHooks;
	#target: SendTarget | undefined;
	/** Rows put away with Clear finished; the server keeps them for its hour. */
	readonly #cleared = new SvelteSet<string>();

	readonly #sharing: () => boolean;

	constructor(
		api: SessionFilesApi,
		machineName: string,
		sharing: () => boolean,
		hooks: SenderHooks
	) {
		this.#api = api;
		this.#sharing = sharing;
		this.#machineName = machineName;
		this.#hooks = hooks;
		this.queue = new UploadQueue(api.uploads, {
			finished: () => undefined,
			wait: hooks.wait
		});
	}

	/** Uploads still running, for the Transfers badge. */
	get running(): number {
		return this.queue.active;
	}

	/** Files are dragged over the screen: ask the machine where they would go. */
	async enter(block: SendBlock, desktopSessionId: string | undefined): Promise<void> {
		if (block.kind === 'blocked') {
			this.overlay = { kind: 'refused', message: block.message };
			return;
		}
		if (this.overlay.kind !== 'hidden') {
			return;
		}
		this.overlay = { kind: 'checking' };
		const target = await this.#lookUp(desktopSessionId);
		if (!this.#stillChecking()) {
			// The drag left meanwhile.
			return;
		}
		this.overlay =
			target.kind === 'ready'
				? { kind: 'ready', user: target.user, folderLabel: target.folderLabel }
				: { kind: 'refused', message: target.message };
	}

	#stillChecking(): boolean {
		return this.overlay.kind === 'checking';
	}

	leave(): void {
		this.overlay = { kind: 'hidden' };
	}

	async #lookUp(desktopSessionId: string | undefined): Promise<SendTarget> {
		if (desktopSessionId === undefined) {
			return { kind: 'refused', message: 'Connect to the screen first.' };
		}
		const answer = await this.#api.target(desktopSessionId);
		this.#target = answer.ok ? answer.data : undefined;
		return answer.ok ? answer.data : { kind: 'refused', message: answer.message };
	}

	/** Sends a drop (or the files picked with Upload files); refusals go to the notice. */
	async send(
		chosen: readonly Chosen[],
		block: SendBlock,
		desktopSessionId: string | undefined
	): Promise<void> {
		this.leave();
		if (chosen.length === 0) {
			return;
		}
		if (block.kind === 'blocked') {
			this.#hooks.notify('error', block.message);
			return;
		}
		const target = this.#target ?? (await this.#lookUp(desktopSessionId));
		if (target.kind === 'refused' || desktopSessionId === undefined) {
			this.#hooks.notify(
				'error',
				target.kind === 'refused' ? target.message : 'Connect to the screen first.'
			);
			return;
		}
		const problem = dropProblem(
			chosen.map(({ file, isFolder }) => ({ name: file.name, size: file.size, isFolder })),
			{ maxBytes: Number.MAX_SAFE_INTEGER, maxGb: 0, free: target.free }
		);
		if (problem !== undefined) {
			this.#hooks.notify('error', problem);
			return;
		}
		const batchId = crypto.randomUUID();
		const uploads = this.queue.add(
			chosen.map(({ file }) => ({
				file,
				destination: { kind: 'session', desktopSessionId, batchId }
			}))
		);
		void this.refreshRows();
		await this.#settled(uploads);
		const finished = await this.#api.finish(batchId, this.#sharing());
		void this.refreshRows();
		const results = uploads
			.filter((upload) => upload.state.kind !== 'cancelled')
			.map((upload) =>
				upload.state.kind === 'failed'
					? { kind: 'failed' as const, name: upload.name, message: upload.state.message }
					: { kind: 'saved' as const, name: upload.savedAs ?? upload.name }
			);
		if (results.length === 0) {
			return;
		}
		const notice = sentNotice(results, {
			user: target.user,
			folderLabel: target.folderLabel,
			machine: this.#machineName
		});
		// SF20: where the saved files are besides Downloads.
		const anySaved = results.some((result) => result.kind === 'saved');
		const clipboard = !anySaved
			? ''
			: !this.#sharing()
				? " Share clipboard is off, so they are not on the machine's clipboard."
				: finished.ok && finished.data.onClipboard
					? " They're on the machine's clipboard: paste with Ctrl+V."
					: '';
		this.#hooks.notify(notice.tone, `${notice.text}${clipboard}`);
		// The folder or the person may have changed by the next drop.
		this.#target = undefined;
	}

	async #settled(uploads: readonly Upload<SessionDestination>[]): Promise<void> {
		while (!uploads.every((upload) => SETTLED.includes(upload.state.kind))) {
			await this.#hooks.wait(200);
		}
	}

	/** Cancels a row: this page's own upload, or one the server still runs. */
	cancel(transferId: string): void {
		const upload = this.queue.items.find((item) => item.remoteId === transferId);
		if (upload === undefined) {
			void this.#api.cancelTransfer(transferId).then(() => this.refreshRows());
		} else {
			this.queue.cancel(upload);
			void this.refreshRows();
		}
	}

	/** Fills the Transfers panel from the server. */
	async refreshRows(): Promise<void> {
		const listed = await this.#api.transfers();
		if (listed.ok) {
			this.rows = listed.data.transfers.filter((row) => !this.#cleared.has(row.id));
		}
	}

	/** Clear finished: the rows that are no longer running, here and in this page's queue. */
	clearFinished(): void {
		for (const row of this.rows) {
			if (row.state.kind !== 'running') {
				this.#cleared.add(row.id);
			}
		}
		this.rows = this.rows.filter((row) => row.state.kind === 'running');
		this.queue.clearFinished();
	}

	/** The bytes sent so far for a row: this page's live count, or the server's. */
	sentFor(row: TransferRow): number {
		const upload = this.queue.items.find((item) => item.remoteId === row.id);
		return upload === undefined ? row.bytes : upload.sent;
	}
}

/** The files of a drop, with folders marked (they cannot be sent yet, question 4). */
export function chosenFromDrop(transfer: DataTransfer): Chosen[] {
	const items = [...transfer.items].filter((item) => item.kind === 'file');
	if (items.length === transfer.files.length) {
		return items.flatMap((item, index) => {
			const file = transfer.files[index];
			return file === undefined
				? []
				: [{ file, isFolder: item.webkitGetAsEntry()?.isDirectory === true }];
		});
	}
	return [...transfer.files].map((file) => ({ file, isFolder: false }));
}
