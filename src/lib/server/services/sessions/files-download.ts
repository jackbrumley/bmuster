import { createHash } from 'node:crypto';
import { baseName, pathFlavour } from '#lib/domain/files/files.ts';
import { agentReadDoneSchema, agentStatSchema } from '#lib/schemas/files/files.ts';
import type { FilesChannel, ReadHandle } from './files-channel.ts';
import {
	ANSWER_MS,
	auditFiles,
	outcomeOf,
	withChannel,
	type FilesContext,
	type FilesOutcome
} from './files.ts';
import { fileDownload } from './range.ts';

/**
 * Downloads (SPEC-FILES F5): streamed from the agent through the server,
 * never stored. The headers let a browser's download manager show progress
 * and resume (Content-Length, Accept-Ranges, ETag, Last-Modified, Range and
 * If-Range). The server hashes what it sends, for the audit.
 */

/** A read that has gone quiet this long has failed (the agent gives up after 2 min unacknowledged). */
const READ_QUIET_MS = 3 * 60_000;

/** Bytes buffered for a slow browser before the agent is asked to wait. */
const BUFFER_BYTES = 1024 * 1024;

export type DownloadRequest = {
	path: string;
	method: 'GET' | 'HEAD';
	range: string | null;
	ifRange: string | null;
};

export function downloadFile(
	context: FilesContext,
	request: DownloadRequest
): Promise<FilesOutcome<Response>> {
	return withChannel(context, async (channel, machine) => {
		const stat = outcomeOf(
			await channel.ask({ op: 'stat', path: request.path }, ANSWER_MS.quick),
			agentStatSchema
		);
		if (stat.kind === 'refused') {
			return stat;
		}
		if (stat.value.kind !== 'file') {
			return { kind: 'refused', status: 400, message: 'Only files can be downloaded.' };
		}
		const size = stat.value.size;
		const modifiedMs = stat.value.modifiedMs ?? 0;
		const { headers, plan } = fileDownload(
			{
				name: baseName(pathFlavour(machine.osFamily), request.path),
				size,
				modifiedMs
			},
			request
		);
		if (plan.kind === 'unsatisfiable') {
			return { kind: 'ok', value: new Response(null, { status: 416, headers }) };
		}
		const { status, start, length } = plan;
		if (request.method === 'HEAD' || length === 0) {
			return { kind: 'ok', value: new Response(null, { status, headers }) };
		}
		const rangeText = status === 206 ? `bytes ${start}-${start + length - 1}` : 'the whole file';
		return stream(
			channel,
			{ path: request.path, offset: start, length },
			(sent, sha256, completed) => {
				auditFiles(context, machine, 'file-downloaded', {
					path: request.path,
					size: String(size),
					range: rangeText,
					sent: String(sent),
					'sha-256': sha256,
					completed: completed ? 'yes' : 'no'
				});
			}
		).then((body) =>
			body.kind === 'ok'
				? { kind: 'ok', value: new Response(body.value, { status, headers }) }
				: body
		);
	});
}

/**
 * The read as a body stream. The agent is acknowledged as the browser takes
 * the bytes, so a slow browser slows the agent and the server holds about
 * 1 MB at most. `finished` hears once how it ended.
 */
async function stream(
	channel: FilesChannel,
	target: { path: string; offset: number; length: number },
	finished: (sent: number, sha256: string, completed: boolean) => void
): Promise<FilesOutcome<ReadableStream<Uint8Array>>> {
	const hash = createHash('sha256');
	let sent = 0;
	let unacked = 0;
	let over = false;
	// Set once the read starts; the stream callbacks may run before that.
	const reader: { handle: ReadHandle | undefined } = { handle: undefined };
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	const finish = (completed: boolean): void => {
		if (!over) {
			over = true;
			finished(sent, hash.digest('hex'), completed);
		}
	};
	const body = new ReadableStream<Uint8Array>(
		{
			start(started) {
				controller = started;
			},
			pull() {
				if (unacked > 0) {
					reader.handle?.ack(unacked);
					unacked = 0;
				}
			},
			cancel() {
				reader.handle?.cancel();
				finish(false);
			}
		},
		{ highWaterMark: BUFFER_BYTES, size: (chunk) => chunk.byteLength }
	);
	const reading = await channel.read(
		{ op: 'read', ...target },
		(data) => {
			if (over || controller === undefined) {
				return;
			}
			const copy = data.slice();
			hash.update(copy);
			sent += copy.byteLength;
			unacked += copy.byteLength;
			controller.enqueue(copy);
			if ((controller.desiredSize ?? 0) > 0) {
				reader.handle?.ack(unacked);
				unacked = 0;
			}
		},
		READ_QUIET_MS
	);
	if (reading.kind === 'failed') {
		// Nothing was sent, so there is nothing to audit.
		over = true;
		const failed = outcomeOf(reading.answer, agentReadDoneSchema);
		return failed.kind === 'refused'
			? failed
			: { kind: 'refused', status: 502, message: 'The download could not start.' };
	}
	reader.handle = reading.handle;
	void reading.handle.done.then((answer) => {
		if (over) {
			return;
		}
		const done = outcomeOf(answer, agentReadDoneSchema);
		if (done.kind === 'ok' && sent === target.length) {
			controller?.close();
			finish(true);
		} else {
			controller?.error(
				new Error(done.kind === 'refused' ? done.message : 'The file changed during the download.')
			);
			finish(false);
		}
	});
	return { kind: 'ok', value: body };
}
