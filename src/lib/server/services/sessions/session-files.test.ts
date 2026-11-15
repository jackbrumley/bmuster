import { afterEach, describe, expect, it } from 'vitest';
import { grantAccess } from '#tests/helpers/access.ts';
import { sha256 } from '#tests/helpers/files-agent.ts';
import { NOW } from '#tests/helpers/people.ts';
import {
	disconnectSessionFilesAgents,
	fakeAgent,
	setUp
} from '#tests/helpers/session-files-agent.ts';
import { deleteRule } from '../access/rules.ts';
import { listAudit } from '../audit/audit.ts';
import { updateSetting } from '../settings/settings.ts';
import {
	beginSend,
	cancelSend,
	clipboardOffer,
	endSend,
	finishSend,
	listTransfers,
	sendChunk,
	sendTarget,
	type SessionFilesContext
} from './session-files.ts';
import { downloadOffer } from './session-files-download.ts';

// SPEC-SESSION-FILES: files sent through a desktop session, on the server.

afterEach(disconnectSessionFilesAgents);

const BATCH = '0f0e0d0c-0b0a-4908-8706-050403020100';

async function sendFile(
	context: SessionFilesContext,
	desktopSessionId: string,
	name: string,
	bytes: Uint8Array
) {
	const begun = await beginSend(context, {
		desktopSessionId,
		batchId: BATCH,
		transferId: null,
		name,
		size: bytes.byteLength
	});
	if (begun.kind !== 'ok') throw new Error(begun.message);
	const chunk = await sendChunk(context, { transferId: begun.value.transferId, offset: 0 }, bytes);
	if (chunk.kind !== 'ok') throw new Error(chunk.message);
	return {
		transferId: begun.value.transferId,
		ended: await endSend(context, { transferId: begun.value.transferId, sha256: sha256(bytes) })
	};
}

describe('who may send files through a screen', () => {
	it('SF1: needs view (404), files and control (403) and a live control session of their own (409); taking a permission away stops the next chunk', async () => {
		const { database, admin, pat, machineId, relay, context, desktop } = await setUp();
		const agent = fakeAgent(relay, machineId);
		const mine = desktop(pat, 'control');
		expect(await sendTarget(context(pat), mine)).toMatchObject({ kind: 'refused', status: 404 });
		grantAccess(database, {
			adminId: admin.id,
			name: 'Files only',
			memberIds: [pat.id],
			machineIds: [machineId],
			permissions: ['view', 'files', 'desktop-view'],
			consent: 'unattended'
		});
		expect(await sendTarget(context(pat), mine)).toMatchObject({ kind: 'refused', status: 403 });
		const { ruleId } = grantAccess(database, {
			adminId: admin.id,
			name: 'Helpdesk',
			memberIds: [pat.id],
			machineIds: [machineId],
			permissions: ['view', 'files', 'desktop-view', 'desktop-control'],
			consent: 'unattended'
		});
		// Watch-only, someone else's, or no session at all: 409.
		for (const other of [desktop(pat, 'watch'), desktop(admin, 'control'), crypto.randomUUID()]) {
			expect(await sendTarget(context(pat), other)).toMatchObject({
				kind: 'refused',
				status: 409,
				message: 'Files can be sent only while you control this screen.'
			});
		}
		expect(await sendTarget(context(pat), mine)).toEqual({
			kind: 'ok',
			value: { kind: 'ready', user: 'kim', folderLabel: 'Downloads/BMuster', free: 50 * 1024 ** 3 }
		});
		// The ticket names the desktop session and carries files and control.
		expect(agent.tickets[0]).toMatchObject({
			purpose: { kind: 'session-files', desktopSessionId: mine }
		});
		expect(agent.tickets[0]?.['permissions']).toEqual(
			expect.arrayContaining(['files', 'desktop-control'])
		);
		const begun = await beginSend(context(pat), {
			desktopSessionId: mine,
			batchId: BATCH,
			transferId: null,
			name: 'a.txt',
			size: 4
		});
		if (begun.kind !== 'ok') throw new Error('not begun');
		deleteRule(database, admin.id, ruleId, NOW);
		expect(
			await sendChunk(
				context(pat),
				{ transferId: begun.value.transferId, offset: 0 },
				new Uint8Array(4)
			)
		).toMatchObject({ kind: 'refused', status: 403 });
		// Someone else cannot see or touch the transfer.
		expect(await cancelSend(context(admin), begun.value.transferId)).toMatchObject({
			kind: 'refused',
			status: 404
		});
	});

	it('SF11: a locked screen or nobody signed in is the overlay text, not an error', async () => {
		const { admin, machineId, relay, context, desktop } = await setUp();
		const agent = fakeAgent(relay, machineId);
		const mine = desktop(admin, 'control');
		agent.state.screen = 'locked';
		expect(await sendTarget(context(admin), mine)).toEqual({
			kind: 'ok',
			value: {
				kind: 'refused',
				message: 'The machine is locked. Unlock it, then send the files again.'
			}
		});
		agent.state.screen = 'nobody';
		const target = await sendTarget(context(admin), mine);
		expect(target).toMatchObject({ kind: 'ok', value: { kind: 'refused' } });
		expect(JSON.stringify(target)).toMatch(
			/Nobody is signed in on .+, so there is no Downloads folder to send to\./
		);
	});
});

describe('sending', () => {
	it('SF9: refuses a file over maxUploadGb and a 101st file in one drop before asking the machine', async () => {
		const { database, admin, machineId, relay, context, desktop } = await setUp();
		const agent = fakeAgent(relay, machineId);
		const mine = desktop(admin, 'control');
		updateSetting(database, admin.id, 'maxUploadGb', 10, NOW);
		expect(
			await beginSend(context(admin), {
				desktopSessionId: mine,
				batchId: BATCH,
				transferId: null,
				name: 'report.iso',
				size: 12 * 1024 ** 3
			})
		).toEqual({
			kind: 'refused',
			status: 413,
			message: 'report.iso is 12.0 GB; files can be at most 10 GB (Settings → Files).'
		});
		for (let n = 0; n < 100; n += 1) {
			const begun = await beginSend(context(admin), {
				desktopSessionId: mine,
				batchId: BATCH,
				transferId: null,
				name: `f${n}.txt`,
				size: 1
			});
			expect(begun.kind).toBe('ok');
		}
		expect(
			await beginSend(context(admin), {
				desktopSessionId: mine,
				batchId: BATCH,
				transferId: null,
				name: 'one-more.txt',
				size: 1
			})
		).toMatchObject({ kind: 'refused', status: 413, message: 'Send at most 100 files at once.' });
		expect(agent.requests.filter((request) => request.op === 'send-begin')).toHaveLength(100);
	});

	it('SF18: one desktop-files entry per transfer with direction, people, name, size, bytes and SHA-256; never contents', async () => {
		const { database, admin, machineId, relay, context, desktop } = await setUp();
		const agent = fakeAgent(relay, machineId);
		agent.saved.set('report.pdf', new Uint8Array([1]));
		const mine = desktop(admin, 'control');
		await sendTarget(context(admin), mine);
		const bytes = new TextEncoder().encode('secret contents');
		const { ended, transferId } = await sendFile(context(admin), mine, 'report.pdf', bytes);
		expect(ended).toEqual({ kind: 'ok', value: { savedAs: 'report.pdf (2)' } });
		const cancelled = await beginSend(context(admin), {
			desktopSessionId: mine,
			batchId: BATCH,
			transferId: null,
			name: 'big.bin',
			size: 10
		});
		if (cancelled.kind !== 'ok') throw new Error('not begun');
		await cancelSend(context(admin), cancelled.value.transferId);
		expect(await finishSend(context(admin), BATCH, true)).toEqual({
			kind: 'ok',
			value: { onClipboard: true }
		});
		const finish = agent.requests.find((request) => request.op === 'send-finish');
		expect(finish).toMatchObject({
			transferIds: [transferId],
			sender: admin.name,
			clipboard: true
		});

		const entries = listAudit(database, 50).filter((entry) => entry.kind === 'desktop-files');
		expect(entries).toHaveLength(2);
		const [cancelledEntry, savedEntry] = entries;
		expect(savedEntry?.detail).toEqual({
			direction: 'to-machine',
			desktop: mine,
			'signed in at the machine': 'kim',
			folder: 'Downloads/BMuster',
			name: 'report.pdf (2)',
			sent: 'report.pdf',
			size: String(bytes.byteLength),
			bytes: String(bytes.byteLength),
			completed: 'yes',
			'sha-256': sha256(bytes)
		});
		expect(cancelledEntry?.detail).toMatchObject({
			name: 'big.bin',
			completed: 'no',
			reason: 'Cancelled'
		});
		expect(JSON.stringify(entries)).not.toContain('secret contents');
		// SF16: the Transfers panel's list, newest first, survives a reload (it is the server's).
		const listed = listTransfers(context(admin));
		expect(listed).toMatchObject({
			kind: 'ok',
			value: [
				{ name: 'big.bin', state: { kind: 'cancelled' } },
				{ name: 'report.pdf', state: { kind: 'done', savedAs: 'report.pdf (2)' } }
			]
		});
	});

	it('a file that arrives changed fails, is audited, and is not retried as if the connection dropped', async () => {
		const { database, admin, machineId, relay, context, desktop } = await setUp();
		fakeAgent(relay, machineId);
		const mine = desktop(admin, 'control');
		const begun = await beginSend(context(admin), {
			desktopSessionId: mine,
			batchId: BATCH,
			transferId: null,
			name: 'report.pdf',
			size: 3
		});
		if (begun.kind !== 'ok') throw new Error('not begun');
		await sendChunk(
			context(admin),
			{ transferId: begun.value.transferId, offset: 0 },
			new Uint8Array(3)
		);
		expect(
			await endSend(context(admin), { transferId: begun.value.transferId, sha256: '0'.repeat(64) })
		).toMatchObject({ kind: 'refused', status: 422 });
		expect(
			listAudit(database, 10).find((entry) => entry.kind === 'desktop-files')?.detail
		).toMatchObject({
			completed: 'no'
		});
	});
});

describe('files copied on the machine', () => {
	const OFFER = '0123456789abcdef0123456789abcdef';

	it("SF26: offers need files and control and the person's own control session, checked on every request", async () => {
		const { database, admin, pat, machineId, relay, context, desktop } = await setUp();
		const agent = fakeAgent(relay, machineId);
		agent.copied.offerId = OFFER;
		agent.copied.files = [{ path: 'report.pdf', data: new Uint8Array([1, 2, 3]) }];
		const watching = desktop(pat, 'watch');
		const { ruleId } = grantAccess(database, {
			adminId: admin.id,
			name: 'Helpdesk',
			memberIds: [pat.id],
			machineIds: [machineId],
			permissions: ['view', 'desktop-view', 'desktop-control'],
			consent: 'unattended'
		});
		const mine = desktop(pat, 'control');
		// Control without files: refused.
		expect(await clipboardOffer(context(pat), mine)).toMatchObject({
			kind: 'refused',
			status: 403
		});
		deleteRule(database, admin.id, ruleId, NOW);
		grantAccess(database, {
			adminId: admin.id,
			name: 'Helpdesk with files',
			memberIds: [pat.id],
			machineIds: [machineId],
			permissions: ['view', 'files', 'desktop-view', 'desktop-control'],
			consent: 'unattended'
		});
		// A watch-only session never gets an offer.
		expect(await clipboardOffer(context(pat), watching)).toMatchObject({
			kind: 'refused',
			status: 409
		});
		expect(agent.requests.filter((request) => request.op === 'offer')).toHaveLength(0);
		expect(await clipboardOffer(context(pat), mine)).toEqual({
			kind: 'ok',
			value: {
				kind: 'offer',
				offerId: OFFER,
				items: [{ name: 'report.pdf', kind: 'file', size: 3 }],
				count: 1,
				totalBytes: 3
			}
		});
	});

	it('SF28: downloading an offer that has ended says to copy again', async () => {
		const { admin, machineId, relay, context, desktop } = await setUp();
		const agent = fakeAgent(relay, machineId);
		agent.copied.offerId = OFFER;
		agent.copied.files = [{ path: 'report.pdf', data: new Uint8Array([1]) }];
		const mine = desktop(admin, 'control');
		// A new copy replaced it.
		agent.copied.offerId = 'ffffffffffffffffffffffffffffffff';
		expect(
			await downloadOffer(context(admin), {
				desktopSessionId: mine,
				offerId: OFFER,
				method: 'GET',
				range: null,
				ifRange: null,
				zipName: 'PC files.zip'
			})
		).toEqual({
			kind: 'refused',
			status: 410,
			message: "Those files are no longer on the machine's clipboard. Copy them again."
		});
	});
});
