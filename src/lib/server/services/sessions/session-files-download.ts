import { createHash } from 'node:crypto';
import { agentWalkSchema } from '#lib/schemas/session-files/session-files.ts';
import { recordAudit } from '../audit/audit.ts';
import { parseRange, rangeStillValid, type ByteRange } from './range.ts';
import {
	ANSWER_MS,
	outcomeOf,
	withChannel,
	type Outcome,
	type SessionFilesChannel,
	type SessionFilesContext
} from './session-files.ts';
import type { Transfer } from './session-files-transfers.ts';
import { zipLength, zipStream, type ZipEntry } from './zip-stream.ts';

/**
 * Downloading the files copied on the machine (SPEC-SESSION-FILES 3.2, SF25): one file as
 * itself, with Range so the browser can resume it; several, or a folder, as one streamed zip.
 * The bytes pass through the server, acknowledged as the browser takes them, never stored.
 * Each file is hashed as it passes, for the audit (SF18).
 */

/** A read that has gone quiet this long has failed. */
const READ_QUIET_MS = 3 * 60_000;

/** At most this many items are named in an audit entry. */
const AUDITED_ITEMS = 1000;

export type OfferDownload = {
	desktopSessionId: string;
	offerId: string;
	method: 'GET' | 'HEAD';
	range: string | null;
	ifRange: string | null;
	/** "PC-12 files 2026-11-15.zip". */
	zipName: string;
};

/** `attachment` with an ASCII fallback name and the real one (RFC 6266). */
function disposition(name: string): string {
	const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * The bytes of one read, as they arrive, acknowledged once taken. Ending early (the browser went
 * away) cancels the read on the machine.
 */
async function* streamed(
	channel: SessionFilesChannel,
	request: { offerId: string; entry: number; offset: number; length: number },
	passed: (data: Uint8Array) => void
): AsyncGenerator<Uint8Array> {
	if (request.length === 0) {
		return;
	}
	const queue: Uint8Array[] = [];
	let wake: (() => void) | undefined;
	let ended: { kind: 'done' } | { kind: 'error'; message: string } | undefined;
	const reading = await channel.read(
		{ op: 'offer-read', ...request },
		(data) => {
			queue.push(data.slice());
			wake?.();
		},
		READ_QUIET_MS
	);
	if (reading.kind === 'failed') {
		throw new Error(
			reading.answer.kind === 'error' ? reading.answer.message : 'The read did not start.'
		);
	}
	void reading.handle.done.then((answer) => {
		ended = answer.kind === 'done' ? { kind: 'done' } : { kind: 'error', message: answer.message };
		wake?.();
	});
	try {
		for (;;) {
			const next = queue.shift();
			if (next !== undefined) {
				passed(next);
				yield next;
				reading.handle.ack(next.byteLength);
				continue;
			}
			if (ended !== undefined) {
				if (ended.kind === 'error') {
					throw new Error(ended.message);
				}
				return;
			}
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
			wake = undefined;
		}
	} finally {
		if (ended === undefined) {
			reading.handle.cancel();
		}
	}
}

type Item = { name: string; size: number; sha256: string; bytes: number };

/** Hashes and counts each item's bytes, and hears once how the download ended. */
class Tally {
	readonly items: Item[] = [];
	readonly whole = createHash('sha256');
	sent = 0;
	#over = false;

	readonly transfer: Transfer;
	readonly finished: (tally: Tally, completed: boolean, reason: string) => void;

	constructor(
		transfer: Transfer,
		finished: (tally: Tally, completed: boolean, reason: string) => void
	) {
		this.transfer = transfer;
		this.finished = finished;
	}

	item(name: string, size: number): (data: Uint8Array) => void {
		const hash = createHash('sha256');
		const item: Item = { name, size, sha256: '', bytes: 0 };
		this.items.push(item);
		return (data) => {
			hash.update(data);
			item.bytes += data.byteLength;
			if (item.bytes === size) {
				item.sha256 = hash.digest('hex');
			}
		};
	}

	end(completed: boolean, reason: string): void {
		if (!this.#over) {
			this.#over = true;
			this.finished(this, completed, reason);
		}
	}
}

/** One file of the walk as itself, with Range and If-Range. */
function single(
	channel: SessionFilesChannel,
	request: OfferDownload,
	entry: { path: string; size: number; modifiedMs: number },
	tally: Tally
): Response {
	const { size, modifiedMs } = entry;
	const etag = `"${size.toString(36)}-${modifiedMs.toString(36)}"`;
	const lastModified = new Date(modifiedMs).toUTCString();
	const range: ByteRange = rangeStillValid(request.ifRange, { etag, lastModified })
		? parseRange(request.range, size)
		: { kind: 'whole' };
	const headers = new Headers({
		'accept-ranges': 'bytes',
		'cache-control': 'no-store',
		'content-disposition': disposition(entry.path),
		'content-type': 'application/octet-stream',
		etag,
		'last-modified': lastModified,
		'x-content-type-options': 'nosniff'
	});
	if (range.kind === 'unsatisfiable') {
		headers.set('content-range', `bytes */${size}`);
		tally.end(false, 'The range asked for is outside the file.');
		return new Response(null, { status: 416, headers });
	}
	const start = range.kind === 'part' ? range.start : 0;
	const length = range.kind === 'part' ? range.end - range.start + 1 : size;
	headers.set('content-length', String(length));
	if (range.kind === 'part') {
		headers.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
	}
	const status = range.kind === 'part' ? 206 : 200;
	if (request.method === 'HEAD' || length === 0) {
		tally.end(length === 0, length === 0 ? '' : 'Headers only.');
		return new Response(null, { status, headers });
	}
	const count = tally.item(entry.path, size);
	const body = guarded(
		streamed(channel, { offerId: request.offerId, entry: 0, offset: start, length }, (data) => {
			count(data);
			tally.sent += data.byteLength;
			tally.transfer.bytes = tally.sent;
		}),
		tally
	);
	return new Response(toStream(body), { status, headers });
}

/** A body that reads the generator only as the browser takes it; a cancel ends the generator. */
function toStream(body: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				const next = await body.next();
				if (next.done === true) {
					controller.close();
				} else {
					controller.enqueue(next.value);
				}
			},
			async cancel() {
				await body.return(undefined);
			}
		},
		{ highWaterMark: 0 }
	);
}

/** Ends the tally when the body is done, fails, or the browser goes away. */
async function* guarded(
	body: AsyncGenerator<Uint8Array>,
	tally: Tally
): AsyncGenerator<Uint8Array> {
	let completed = false;
	let reason = 'The download was stopped.';
	try {
		yield* body;
		completed = true;
	} catch (error) {
		reason = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		tally.end(completed, completed ? '' : reason);
	}
}

/** Several files, or a folder: one streamed zip, with SKIPPED.txt when anything was left out. */
function zipped(
	channel: SessionFilesChannel,
	request: OfferDownload,
	walk: {
		entries: { path: string; size: number; modifiedMs: number }[];
		skipped: { path: string; reason: string }[];
	},
	tally: Tally
): Response {
	const entries: ZipEntry[] = walk.entries.map((entry, index) => ({
		name: entry.path,
		size: entry.size,
		modifiedMs: entry.modifiedMs,
		bytes: () =>
			streamed(
				channel,
				{ offerId: request.offerId, entry: index, offset: 0, length: entry.size },
				tally.item(entry.path, entry.size)
			)
	}));
	if (walk.skipped.length > 0) {
		const text = new TextEncoder().encode(
			walk.skipped.map((skip) => `${skip.path}: ${skip.reason}\r\n`).join('')
		);
		entries.push({
			name: 'SKIPPED.txt',
			size: text.byteLength,
			modifiedMs: Date.now(),
			bytes: async function* () {
				await Promise.resolve();
				yield text;
			}
		});
	}
	const length = zipLength(entries);
	tally.transfer.size = length;
	const headers = new Headers({
		'cache-control': 'no-store',
		'content-disposition': disposition(request.zipName),
		'content-type': 'application/zip',
		'content-length': String(length),
		'x-content-type-options': 'nosniff'
	});
	if (request.method === 'HEAD') {
		tally.end(false, 'Headers only.');
		return new Response(null, { status: 200, headers });
	}
	async function* counted(): AsyncGenerator<Uint8Array> {
		for await (const piece of zipStream(entries)) {
			tally.whole.update(piece);
			tally.sent += piece.byteLength;
			tally.transfer.bytes = tally.sent;
			yield piece;
		}
	}
	return new Response(toStream(guarded(counted(), tally)), { status: 200, headers });
}

/** The audit entry for one download (SF18): names, sizes and SHA-256, never contents. */
function audit(context: SessionFilesContext, machineName: string, desktopSessionId: string) {
	return (tally: Tally, completed: boolean, reason: string, zip: boolean): void => {
		const items = tally.items.slice(0, AUDITED_ITEMS).map((item) => {
			const hash = item.sha256 === '' ? 'not finished' : `sha-256 ${item.sha256}`;
			return `${item.name} (${item.size} bytes, sent ${item.bytes}, ${hash})`;
		});
		recordAudit(
			context.database,
			{
				actor: { kind: 'user', userId: context.user.id },
				kind: 'desktop-files',
				target: machineName,
				machineId: context.machineId,
				detail: {
					direction: 'from-machine',
					desktop: desktopSessionId,
					'signed in at the machine': tally.transfer.place.user,
					name: tally.transfer.name,
					items: items.join('\n'),
					count: String(tally.items.length),
					size: String(tally.transfer.size),
					bytes: String(tally.sent),
					completed: completed ? 'yes' : 'no',
					...(zip && completed ? { 'zip sha-256': tally.whole.digest('hex') } : {}),
					...(completed ? {} : { reason })
				}
			},
			Date.now()
		);
	};
}

/** The offer's download: one file with Range, or the zip (SF25, SF28). */
export function downloadOffer(
	context: SessionFilesContext,
	request: OfferDownload
): Promise<Outcome<Response>> {
	return withChannel(context, request.desktopSessionId, async (channel, access) => {
		const walked = outcomeOf(
			await channel.ask({ op: 'offer-stat', offerId: request.offerId }, ANSWER_MS.slow),
			agentWalkSchema,
			access.machineName
		);
		if (walked.kind === 'refused') {
			return walked;
		}
		const walk = walked.value;
		const first = walk.entries[0];
		const one = walk.single && first !== undefined;
		const total = walk.entries.reduce((sum, entry) => sum + entry.size, 0);
		const transfer: Transfer = {
			id: crypto.randomUUID(),
			direction: 'from-machine',
			userId: context.user.id,
			machineId: context.machineId,
			desktopSessionId: request.desktopSessionId,
			batchId: request.offerId,
			name: one ? first.path : `${walk.entries.length} files (zip)`,
			size: total,
			bytes: 0,
			startedAt: context.now,
			endedAt: undefined,
			state: { kind: 'running' },
			place: { user: 'the person signed in', folderLabel: '' }
		};
		const record = audit(context, access.machineName, request.desktopSessionId);
		// HEAD asks only for headers: no transfer row, no audit.
		const listed = request.method === 'GET';
		if (listed) {
			context.transfers.add(transfer);
		}
		const tally = new Tally(transfer, (ended, completed, reason) => {
			if (!listed) {
				return;
			}
			context.transfers.end(
				transfer,
				completed ? { kind: 'done', savedAs: transfer.name } : { kind: 'failed', message: reason },
				Date.now()
			);
			record(ended, completed, reason, !one);
		});
		const response = one
			? single(channel, request, first, tally)
			: zipped(channel, request, walk, tally);
		return { kind: 'ok', value: response };
	});
}
