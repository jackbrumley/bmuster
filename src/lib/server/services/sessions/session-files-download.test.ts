import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sha256 } from '#tests/helpers/files-agent.ts';
import {
	disconnectSessionFilesAgents,
	fakeAgent,
	setUp
} from '#tests/helpers/session-files-agent.ts';
import { listAudit } from '../audit/audit.ts';
import { downloadOffer, type OfferDownload } from './session-files-download.ts';
import { listTransfers } from './session-files.ts';

// SPEC-SESSION-FILES SF25: downloading the files copied on the machine.

afterEach(disconnectSessionFilesAgents);

const OFFER = '0123456789abcdef0123456789abcdef';

async function body(response: Response): Promise<Uint8Array> {
	return new Uint8Array(await response.arrayBuffer());
}

async function prepared(files: { path: string; data: Uint8Array }[]) {
	const setup = await setUp();
	const agent = fakeAgent(setup.relay, setup.machineId);
	agent.copied.offerId = OFFER;
	agent.copied.files = files;
	const desktop = setup.desktop(setup.admin, 'control');
	const request = (extra: Partial<OfferDownload>): OfferDownload => ({
		desktopSessionId: desktop,
		offerId: OFFER,
		method: 'GET',
		range: null,
		ifRange: null,
		zipName: 'Reception PC files 2026-11-15.zip',
		...extra
	});
	return { ...setup, agent, request };
}

describe('downloading copied files', () => {
	it('SF25: one file downloads as itself with Range, If-Range, Content-Length and Content-Disposition', async () => {
		const data = new Uint8Array(100).map((_, i) => i);
		const { admin, context, request, database } = await prepared([{ path: 'report é.pdf', data }]);
		const whole = await downloadOffer(context(admin), request({}));
		if (whole.kind !== 'ok') throw new Error(whole.message);
		expect(whole.value.status).toBe(200);
		expect(whole.value.headers.get('content-length')).toBe('100');
		expect(whole.value.headers.get('accept-ranges')).toBe('bytes');
		expect(whole.value.headers.get('content-disposition')).toBe(
			'attachment; filename="report _.pdf"; filename*=UTF-8\'\'report%20%C3%A9.pdf'
		);
		expect(await body(whole.value)).toEqual(data);
		const etag = whole.value.headers.get('etag');

		const part = await downloadOffer(
			context(admin),
			request({ range: 'bytes=90-', ifRange: etag })
		);
		if (part.kind !== 'ok') throw new Error(part.message);
		expect(part.value.status).toBe(206);
		expect(part.value.headers.get('content-range')).toBe('bytes 90-99/100');
		expect(await body(part.value)).toEqual(data.subarray(90));
		// A stale If-Range gets the whole file.
		const stale = await downloadOffer(
			context(admin),
			request({ range: 'bytes=90-', ifRange: '"old"' })
		);
		if (stale.kind !== 'ok') throw new Error(stale.message);
		expect(stale.value.status).toBe(200);
		await stale.value.arrayBuffer();

		const entry = listAudit(database, 10).find((item) => item.kind === 'desktop-files');
		expect(entry?.detail).toMatchObject({
			direction: 'from-machine',
			name: 'report é.pdf',
			completed: 'yes'
		});
		expect(entry?.detail['items']).toContain(`sha-256 ${sha256(data)}`);
	});

	it('SF25: several files download as one stored ZIP64 that unzips byte-exact, with SKIPPED.txt', async () => {
		const files = [
			{ path: 'a.txt', data: new TextEncoder().encode('first file') },
			{ path: 'Folder/b.bin', data: new Uint8Array(5000).map((_, i) => i % 256) }
		];
		const { admin, context, request, agent } = await prepared(files);
		agent.copied.skipped = [{ path: 'Folder/link', reason: 'a link (links are not followed)' }];
		const zipped = await downloadOffer(context(admin), request({}));
		if (zipped.kind !== 'ok') throw new Error(zipped.message);
		expect(zipped.value.headers.get('content-type')).toBe('application/zip');
		expect(zipped.value.headers.get('content-disposition')).toContain(
			'Reception PC files 2026-11-15.zip'
		);
		const zip = await body(zipped.value);
		expect(String(zip.byteLength)).toBe(zipped.value.headers.get('content-length'));
		const dir = mkdtempSync(join(tmpdir(), 'bmuster-offer-'));
		try {
			writeFileSync(join(dir, 'files.zip'), zip);
			execFileSync(
				'python3',
				[
					'-I',
					'-c',
					'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
					join(dir, 'files.zip'),
					join(dir, 'out')
				],
				{ stdio: 'ignore' }
			);
			for (const file of files) {
				expect(new Uint8Array(readFileSync(join(dir, 'out', file.path)))).toEqual(file.data);
			}
			expect(readFileSync(join(dir, 'out', 'SKIPPED.txt'), 'utf8')).toBe(
				'Folder/link: a link (links are not followed)\r\n'
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		const rows = listTransfers(context(admin));
		expect(rows).toMatchObject({
			kind: 'ok',
			value: [{ direction: 'from-machine', name: '2 files (zip)', state: { kind: 'done' } }]
		});
	});
});
