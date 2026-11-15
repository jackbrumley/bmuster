import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { TransferRow } from '#lib/domain/session-files/session-files.ts';
import '#lib/ui/design-tokens.css';
import type { SessionFilesApi } from './session-files-api.ts';
import { SessionFileSender } from './session-file-sender.svelte.ts';
import TransfersPanel from './transfers-panel.svelte';

// SPEC-SESSION-FILES: the browser's side of sending files through the screen.

const DESKTOP = '33333333-3333-4333-8333-333333333333';

/** A pretend server: refuses files named in `refuse`, and keeps the rows the panel lists. */
function fakeApi(refuse: Record<string, string>, rows: TransferRow[]) {
	const calls: string[] = [];
	let next = 0;
	const api: SessionFilesApi = {
		uploads: {
			begin: (upload) => {
				calls.push(`begin ${upload.name}`);
				const refusal = refuse[upload.name];
				if (refusal !== undefined) {
					return Promise.resolve({ ok: false, status: 507, message: refusal });
				}
				next += 1;
				upload.remoteId = `00000000-0000-4000-8000-00000000000${next}`;
				return Promise.resolve({ ok: true, data: { partSize: 0 } });
			},
			chunk: (_upload, offset, body, onProgress) => {
				onProgress(body.size);
				return Promise.resolve({ ok: true, data: { partSize: offset + body.size } });
			},
			end: (upload) =>
				Promise.resolve({
					ok: true,
					data: { savedAs: upload.name === 'report.pdf' ? 'report (2).pdf' : upload.name }
				}),
			cancel: () => Promise.resolve()
		},
		cancelTransfer: (transferId) => {
			calls.push(`cancel ${transferId}`);
			return Promise.resolve({ ok: true, data: {} });
		},
		target: () =>
			Promise.resolve({
				ok: true,
				data: { kind: 'ready', user: 'kim', folderLabel: 'Downloads/BMuster', free: 50 * 1024 ** 3 }
			}),
		finish: (batchId, shareClipboard) => {
			calls.push(`finish ${batchId.length} ${String(shareClipboard)}`);
			return Promise.resolve({ ok: true, data: { onClipboard: shareClipboard } });
		},
		offer: () => Promise.resolve({ ok: true, data: { kind: 'none' } }),
		transfers: () => Promise.resolve({ ok: true, data: { transfers: rows } })
	};
	return { api, calls };
}

function sender(api: SessionFilesApi, notices: string[], sharing = false) {
	return new SessionFileSender(api, 'PC-12', () => sharing, {
		notify: (tone, text) => notices.push(`${tone}: ${text}`),
		wait: () => new Promise((resolve) => setTimeout(resolve, 5))
	});
}

const file = (name: string) => ({ file: new File(['data'], name), isFolder: false });

describe('the browser notice', () => {
	it('SF17: names the file, the person and the folder; several files by count', async () => {
		const notices: string[] = [];
		const { api, calls } = fakeApi({}, []);
		const one = sender(api, notices);
		await one.send([file('report.pdf')], { kind: 'none' }, DESKTOP);
		await one.send([file('a.txt'), file('b.txt'), file('c.txt')], { kind: 'none' }, DESKTOP);
		expect(notices).toEqual([
			"success: Sent report (2).pdf to kim's Downloads/BMuster on PC-12. Share clipboard is off, so they are not on the machine's clipboard.",
			"success: Sent 3 files to kim's Downloads/BMuster on PC-12. Share clipboard is off, so they are not on the machine's clipboard."
		]);
		expect(calls.filter((call) => call.startsWith('finish'))).toHaveLength(2);
	});

	it('SF17: a partial drop names each failure', async () => {
		const notices: string[] = [];
		const { api } = fakeApi({ 'big.iso': "There isn't enough room on the machine." }, []);
		await sender(api, notices).send(
			[file('a.txt'), file('big.iso'), file('c.txt')],
			{ kind: 'none' },
			DESKTOP
		);
		expect(notices).toEqual([
			"error: Sent 2 of 3 files to kim's Downloads/BMuster on PC-12. big.iso: There isn't enough room on the machine. Share clipboard is off, so they are not on the machine's clipboard."
		]);
	});

	it('SF15: a dropped folder, more than 100 files or a blocked view sends nothing and says why', async () => {
		const notices: string[] = [];
		const { api, calls } = fakeApi({}, []);
		const one = sender(api, notices);
		await one.send([{ file: new File([], 'Photos'), isFolder: true }], { kind: 'none' }, DESKTOP);
		await one.send(
			Array.from({ length: 101 }, (_, n) => file(`f${n}.txt`)),
			{ kind: 'none' },
			DESKTOP
		);
		await one.send(
			[file('a.txt')],
			{ kind: 'blocked', message: 'Connect to the screen first.' },
			DESKTOP
		);
		expect(notices).toEqual([
			"error: Folders can't be sent yet. Zip the folder, or send the files inside it.",
			'error: Send at most 100 files at once.',
			'error: Connect to the screen first.'
		]);
		expect(calls).toEqual([]);
	});
});

describe('files on the clipboard', () => {
	it('SF20: with Share clipboard on, the agent is asked to and the notice says they can be pasted', async () => {
		const notices: string[] = [];
		const { api, calls } = fakeApi({}, []);
		await sender(api, notices, true).send([file('a.txt')], { kind: 'none' }, DESKTOP);
		expect(calls.filter((call) => call.startsWith('finish'))).toEqual(['finish 36 true']);
		expect(notices).toEqual([
			"success: Sent a.txt to kim's Downloads/BMuster on PC-12. They're on the machine's clipboard: paste with Ctrl+V."
		]);
	});
});

describe('the Transfers panel', () => {
	it('SF16: lists both directions with progress, Cancel and the result; Clear finished empties finished rows', async () => {
		const rows: TransferRow[] = [
			{
				id: '00000000-0000-4000-8000-0000000000a1',
				direction: 'to-machine',
				name: 'setup.exe',
				size: 2048,
				bytes: 1024,
				startedIso: '2026-11-15T10:00:02.000Z',
				state: { kind: 'running' }
			},
			{
				id: '00000000-0000-4000-8000-0000000000a2',
				direction: 'to-machine',
				name: 'report.pdf',
				size: 10,
				bytes: 10,
				startedIso: '2026-11-15T10:00:01.000Z',
				state: { kind: 'done', savedAs: 'report (2).pdf' }
			},
			{
				id: '00000000-0000-4000-8000-0000000000a3',
				direction: 'from-machine',
				name: 'log.txt',
				size: 10,
				bytes: 0,
				startedIso: '2026-11-15T10:00:00.000Z',
				state: {
					kind: 'failed',
					message: "You don't have permission to read log.txt on the machine."
				}
			}
		];
		const { api, calls } = fakeApi({}, rows);
		const one = sender(api, []);
		// After a reload, the rows come back from the server.
		await one.refreshRows();
		await render(TransfersPanel, { sender: one });
		const list = page.getByRole('list', { name: 'Transfers' });
		await expect.element(list.getByText('setup.exe')).toBeVisible();
		await expect.element(list.getByText('1.0 KB of 2.0 KB')).toBeVisible();
		await expect
			.element(page.getByRole('progressbar', { name: 'Sending setup.exe' }))
			.toBeVisible();
		await expect.element(list.getByText('Saved as report (2).pdf')).toBeVisible();
		await expect
			.element(list.getByText("You don't have permission to read log.txt on the machine."))
			.toBeVisible();
		await page.getByRole('button', { name: 'Cancel' }).click();
		expect(calls).toContain('cancel 00000000-0000-4000-8000-0000000000a1');
		await page.getByRole('button', { name: 'Clear finished' }).click();
		await expect.element(list.getByText('report.pdf')).not.toBeInTheDocument();
		await expect.element(list.getByText('setup.exe')).toBeVisible();
	});
});
