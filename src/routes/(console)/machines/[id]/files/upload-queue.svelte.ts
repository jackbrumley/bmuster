import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';
import { UPLOAD_CHUNK_BYTES } from '#lib/domain/files/files.ts';
import type { ApiResult } from '#lib/utils/api-client.ts';

/**
 * Uploads in the Files tab (SPEC-FILES F6, F10): one file at a time, in
 * 8 MB pieces. The browser hashes the file as it sends it; the machine
 * checks that hash before putting the file in place. A dropped connection
 * (or a server or machine that went away for a moment) is retried, and
 * `begin` says how much the machine already holds, so the upload carries on
 * from there rather than starting again.
 */

export type UploadApi = {
	beginUpload(
		dir: string,
		name: string,
		size: number,
		replace: boolean
	): Promise<ApiResult<{ partSize: number }>>;
	uploadChunk(
		target: { dir: string; name: string; offset: number },
		body: Blob,
		onProgress: (sentBytes: number) => void,
		signal: AbortSignal
	): Promise<ApiResult<{ partSize: number }>>;
	endUpload(
		dir: string,
		name: string,
		size: number,
		sha256: string
	): Promise<ApiResult<{ path: string; size: number; sha256: string }>>;
	cancelUpload(dir: string, name: string): Promise<ApiResult<Record<string, never>>>;
};

export type UploadState =
	| { kind: 'waiting' }
	| { kind: 'sending' }
	/** The connection dropped; trying again. */
	| { kind: 'retrying'; message: string }
	/** All sent; the machine is checking the hash. */
	| { kind: 'checking' }
	| { kind: 'done' }
	| { kind: 'failed'; message: string }
	| { kind: 'cancelled' };

export type QueueHooks = {
	/** An upload finished (the folder it went to can be listed again). */
	finished: (upload: Upload) => void;
	/** Waits before trying again; tests make it instant. */
	wait: (ms: number) => Promise<void>;
};

/** Gives up when the connection has not come back for this long. */
const RETRY_FOR_MS = 5 * 60_000;
const FIRST_RETRY_MS = 1_000;
const LONGEST_RETRY_MS = 15_000;

let nextId = 1;

export class Upload {
	readonly id: string;
	readonly file: File;
	readonly dir: string;
	readonly name: string;
	/** Replace a file of the same name (the person said yes). */
	readonly replace: boolean;
	sent = $state(0);
	state = $state<UploadState>({ kind: 'waiting' });
	controller = new AbortController();
	hasher = sha256.create();
	/** Bytes from the start of the file fed to `hasher`. */
	hashed = 0;

	constructor(file: File, dir: string, replace: boolean) {
		this.id = `upload-${nextId++}`;
		this.file = file;
		this.dir = dir;
		this.name = file.name;
		this.replace = replace;
	}

	get size(): number {
		return this.file.size;
	}
}

type Attempt = 'done' | 'retry' | 'cancelled' | { kind: 'failed'; message: string };

/**
 * Worth trying again: no answer (0), a piece out of step with the part file
 * (412), the machine's connection lost (502) or the machine offline or busy
 * (503, 504). Anything else (a name that exists, no space, no permission)
 * stays failed until the person tries again.
 */
function retryable(result: { status: number }): boolean {
	return [0, 412, 502, 503, 504].includes(result.status);
}

export class UploadQueue {
	items = $state<Upload[]>([]);
	readonly #api: UploadApi;
	readonly #hooks: QueueHooks;
	#running = false;

	constructor(api: UploadApi, hooks: QueueHooks) {
		this.#api = api;
		this.#hooks = hooks;
	}

	/** Uploads still to finish. */
	get active(): number {
		return this.items.filter((upload) =>
			['waiting', 'sending', 'retrying', 'checking'].includes(upload.state.kind)
		).length;
	}

	add(files: readonly { file: File; replace: boolean }[], dir: string): void {
		this.items.push(...files.map(({ file, replace }) => new Upload(file, dir, replace)));
		void this.#drain();
	}

	cancel(upload: Upload): void {
		if (['done', 'failed', 'cancelled'].includes(upload.state.kind)) {
			return;
		}
		upload.state = { kind: 'cancelled' };
		upload.controller.abort();
		void this.#api.cancelUpload(upload.dir, upload.name);
	}

	/** Tries a failed upload again, from what the machine already holds. */
	retry(upload: Upload): void {
		if (upload.state.kind !== 'failed') {
			return;
		}
		upload.controller = new AbortController();
		upload.state = { kind: 'waiting' };
		void this.#drain();
	}

	clearFinished(): void {
		this.items = this.items.filter(
			(upload) => !['done', 'failed', 'cancelled'].includes(upload.state.kind)
		);
	}

	async #drain(): Promise<void> {
		if (this.#running) {
			return;
		}
		this.#running = true;
		try {
			for (;;) {
				const next = this.items.find((upload) => upload.state.kind === 'waiting');
				if (next === undefined) {
					return;
				}
				await this.#run(next);
			}
		} finally {
			this.#running = false;
		}
	}

	async #run(upload: Upload): Promise<void> {
		let delay = FIRST_RETRY_MS;
		let troubleSince: number | undefined;
		for (;;) {
			if (upload.state.kind === 'cancelled') {
				return;
			}
			const before = upload.sent;
			const attempt = await this.#attempt(upload);
			if (stopped(upload) || attempt === 'cancelled') {
				return;
			}
			if (attempt === 'done') {
				upload.state = { kind: 'done' };
				this.#hooks.finished(upload);
				return;
			}
			if (attempt !== 'retry') {
				upload.state = { kind: 'failed', message: attempt.message };
				return;
			}
			if (upload.sent > before) {
				troubleSince = undefined;
				delay = FIRST_RETRY_MS;
			}
			troubleSince ??= Date.now();
			if (Date.now() - troubleSince > RETRY_FOR_MS) {
				upload.state = {
					kind: 'failed',
					message: 'The connection did not come back. Try again to carry on from where it stopped.'
				};
				return;
			}
			upload.state = { kind: 'retrying', message: 'Connection lost. Trying again…' };
			await this.#hooks.wait(delay);
			delay = Math.min(delay * 2, LONGEST_RETRY_MS);
		}
	}

	/** One go at the upload, from wherever the machine's part file ends. */
	async #attempt(upload: Upload): Promise<Attempt> {
		const begun = await this.#api.beginUpload(upload.dir, upload.name, upload.size, upload.replace);
		if (!begun.ok) {
			return retryable(begun) ? 'retry' : { kind: 'failed', message: begun.message };
		}
		let offset = begun.data.partSize;
		await hashUpTo(upload, offset);
		upload.sent = offset;
		while (offset < upload.size) {
			if (stopped(upload)) {
				return 'cancelled';
			}
			upload.state = { kind: 'sending' };
			const start = offset;
			const piece = upload.file.slice(start, Math.min(upload.size, start + UPLOAD_CHUNK_BYTES));
			const sent = await this.#api.uploadChunk(
				{ dir: upload.dir, name: upload.name, offset: start },
				piece,
				(bytes) => {
					upload.sent = start + bytes;
				},
				upload.controller.signal
			);
			if (stopped(upload)) {
				return 'cancelled';
			}
			if (!sent.ok) {
				upload.sent = start;
				return retryable(sent) ? 'retry' : { kind: 'failed', message: sent.message };
			}
			upload.hasher.update(new Uint8Array(await piece.arrayBuffer()));
			upload.hashed = start + piece.size;
			offset = sent.data.partSize;
			upload.sent = offset;
			if (offset !== upload.hashed) {
				// Out of step with the machine: ask it where it is.
				return 'retry';
			}
		}
		upload.state = { kind: 'checking' };
		const digest = bytesToHex(upload.hasher.clone().digest());
		const ended = await this.#api.endUpload(upload.dir, upload.name, upload.size, digest);
		if (!ended.ok) {
			return retryable(ended) ? 'retry' : { kind: 'failed', message: ended.message };
		}
		return 'done';
	}
}

/** Whether the person cancelled the upload (a call, so a check made earlier is not assumed to hold). */
function stopped(upload: Upload): boolean {
	return upload.controller.signal.aborted;
}

/** Brings the running hash to `offset` bytes: further on by reading, or from the start. */
async function hashUpTo(upload: Upload, offset: number): Promise<void> {
	if (offset < upload.hashed) {
		upload.hasher = sha256.create();
		upload.hashed = 0;
	}
	while (upload.hashed < offset) {
		const end = Math.min(offset, upload.hashed + UPLOAD_CHUNK_BYTES);
		const piece = upload.file.slice(upload.hashed, end);
		upload.hasher.update(new Uint8Array(await piece.arrayBuffer()));
		upload.hashed = end;
	}
}
