import { describe, expect, it } from 'vitest';
import type { ApiResult } from '#lib/utils/api-client.ts';
import { UploadQueue, type UploadApi } from './upload-queue.svelte.ts';

const MB = 1024 * 1024;

async function sha256Hex(data: Uint8Array<ArrayBuffer>): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', data);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A pretend server and machine: the part file grows with each piece; some calls can fail once. */
function fakeMachine(options: { dropPieceAt: number[]; refuseEnd: boolean }) {
	let part = new Uint8Array(0);
	const calls: string[] = [];
	const drops = [...options.dropPieceAt];
	let finished: { sha256: string } | undefined;
	const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
	const api: UploadApi = {
		beginUpload: (_dir, _name, _size, replace) => {
			calls.push(`begin ${part.byteLength} ${String(replace)}`);
			return Promise.resolve(ok({ partSize: part.byteLength }));
		},
		uploadChunk: async (target, body, onProgress) => {
			calls.push(`piece ${target.offset}`);
			if (drops[0] === target.offset) {
				drops.shift();
				// The connection drops halfway: the machine kept nothing of this piece.
				onProgress(body.size / 2);
				return { ok: false, message: 'Could not reach the server.', status: 0 };
			}
			if (target.offset !== part.byteLength) {
				return { ok: false, message: 'Out of step.', status: 412 };
			}
			const bytes = new Uint8Array(await body.arrayBuffer());
			const grown = new Uint8Array(part.byteLength + bytes.byteLength);
			grown.set(part);
			grown.set(bytes, part.byteLength);
			part = grown;
			onProgress(body.size);
			return ok({ partSize: part.byteLength });
		},
		endUpload: async (dir, name, size, sha256) => {
			calls.push('end');
			const actual = await sha256Hex(part);
			if (options.refuseEnd || actual !== sha256 || size !== part.byteLength) {
				return { ok: false, message: 'The file arrived changed.', status: 422 };
			}
			finished = { sha256 };
			return ok({ path: `${dir}/${name}`, size, sha256 });
		},
		cancelUpload: () => {
			calls.push('cancel');
			part = new Uint8Array(0);
			return Promise.resolve(ok({}));
		}
	};
	return { api, calls, finished: () => finished };
}

function file(size: number): { file: File; bytes: Uint8Array<ArrayBuffer> } {
	const bytes = new Uint8Array(size);
	for (let index = 0; index < size; index += 1) {
		bytes[index] = (index * 7 + 3) % 251;
	}
	return { file: new File([bytes], 'big.bin'), bytes };
}

describe('uploads (SPEC-FILES F6, F10)', () => {
	it('sends 8 MB pieces and carries on from the part file after a dropped connection', async () => {
		const machine = fakeMachine({ dropPieceAt: [8 * MB], refuseEnd: false });
		const done: string[] = [];
		const queue = new UploadQueue(machine.api, {
			finished: (upload) => done.push(upload.name),
			wait: () => Promise.resolve()
		});
		const { file: picked, bytes } = file(20 * MB);
		queue.add([{ file: picked, replace: false }], '/srv');
		await expect.poll(() => done, { timeout: 20_000 }).toEqual(['big.bin']);
		expect(machine.calls).toEqual([
			'begin 0 false',
			'piece 0',
			'piece 8388608',
			'begin 8388608 false',
			'piece 8388608',
			'piece 16777216',
			'end'
		]);
		expect(machine.finished()?.sha256).toBe(await sha256Hex(bytes));
		const upload = queue.items[0];
		expect(upload?.state).toEqual({ kind: 'done' });
		expect(upload?.sent).toBe(20 * MB);
		expect(queue.active).toBe(0);
	});

	it('hashes what the machine already had when it resumes a part file from before', async () => {
		const machine = fakeMachine({ dropPieceAt: [], refuseEnd: false });
		const { file: picked, bytes } = file(10 * MB);
		// An earlier page sent the first piece, then went away.
		await machine.api.uploadChunk(
			{ dir: '/srv', name: 'big.bin', offset: 0 },
			picked.slice(0, 8 * MB),
			() => undefined,
			new AbortController().signal
		);
		const done: string[] = [];
		const queue = new UploadQueue(machine.api, {
			finished: (upload) => done.push(upload.name),
			wait: () => Promise.resolve()
		});
		queue.add([{ file: picked, replace: true }], '/srv');
		await expect.poll(() => done, { timeout: 20_000 }).toEqual(['big.bin']);
		expect(machine.calls.slice(1)).toEqual(['begin 8388608 true', 'piece 8388608', 'end']);
		expect(machine.finished()?.sha256).toBe(await sha256Hex(bytes));
	});

	it('stops with the reason when the machine refuses, and can be tried again', async () => {
		const machine = fakeMachine({ dropPieceAt: [], refuseEnd: true });
		const queue = new UploadQueue(machine.api, {
			finished: () => undefined,
			wait: () => Promise.resolve()
		});
		queue.add([{ file: file(1000).file, replace: false }], '/srv');
		await expect
			.poll(() => queue.items[0]?.state)
			.toEqual({ kind: 'failed', message: 'The file arrived changed.' });
		expect(queue.active).toBe(0);
		const upload = queue.items[0];
		if (upload === undefined) throw new Error('no upload');
		queue.retry(upload);
		await expect.poll(() => machine.calls.filter((call) => call === 'end')).toHaveLength(2);
		queue.clearFinished();
		await expect.poll(() => queue.items).toEqual([]);
	});

	it('cancels an upload and removes its part file', async () => {
		const machine = fakeMachine({ dropPieceAt: [0, 0, 0, 0, 0, 0, 0, 0], refuseEnd: false });
		let release: () => void = () => undefined;
		const queue = new UploadQueue(machine.api, {
			finished: () => undefined,
			// Waits (as after a dropped connection) until the test lets it go.
			wait: () =>
				new Promise((resolve) => {
					release = resolve;
				})
		});
		queue.add([{ file: file(1000).file, replace: false }], '/srv');
		await expect.poll(() => queue.items[0]?.state.kind).toBe('retrying');
		const upload = queue.items[0];
		if (upload === undefined) throw new Error('no upload');
		queue.cancel(upload);
		release();
		expect(upload.state).toEqual({ kind: 'cancelled' });
		await expect.poll(() => machine.calls.at(-1)).toBe('cancel');
		expect(machine.calls.filter((call) => call.startsWith('piece'))).toHaveLength(1);
	});
});
