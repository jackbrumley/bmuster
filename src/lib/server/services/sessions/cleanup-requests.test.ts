import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import type { CleanupItemProgress } from '#lib/domain/storage/cleanup.ts';
import { cleanUpStorageInput, getCleanupResultInput } from '#lib/schemas/mcp/storage-tools.ts';
import { done, grantAccess } from '#tests/helpers/access.ts';
import { disconnectFakeAgents } from '#tests/helpers/files-agent.ts';
import { NOW } from '#tests/helpers/people.ts';
import { MINUTE, setUpStorageAssistant } from '#tests/helpers/storage-assistant.ts';
import { storageCleanups } from '../../database/schema.ts';
import { createGroup, setGroupMembers } from '../access/groups.ts';
import { listAudit } from '../audit/audit.ts';
import { approvalsNav, pendingCleanupsFor } from '../commands/approvers.ts';
import { recordCleanupResult } from '../machines/storage-cleanups.ts';
import {
	cleanUpStorageTool,
	cleanupResultText,
	getCleanupResultTool
} from '../mcp/cleanup-tools.ts';
import { disconnectGrant } from '../oauth/grants.ts';
import { writeApproverSettings } from '../oauth/mcp-settings.ts';
import { cleanupApprovalView } from './cleanup-approval-views.ts';
import {
	approveCleanupRequest,
	denyCleanupRequest,
	expireCleanupRequests,
	requestCleanup,
	settleEndedGrantCleanups
} from './cleanup-requests.ts';

afterEach(disconnectFakeAgents);

const ASKS: ['view', 'ai-view', 'ai-commands', 'files'] = [
	'view',
	'ai-view',
	'ai-commands',
	'files'
];

const NONE = { kind: 'none' } as const;

const DONE: CleanupItemProgress[] = [
	{
		id: 'old-var-tmp',
		state: {
			kind: 'done',
			result: {
				freedBytes: 2048,
				measured: 'counted',
				filesRemoved: 3,
				filesSkipped: 1,
				errors: 0,
				messages: []
			}
		}
	}
];

async function asked() {
	const setUp = await setUpStorageAssistant(ASKS);
	const requested = await requestCleanup(
		setUp.asking(),
		{ id: setUp.machineId, name: 'test-machine' },
		['old-var-tmp'],
		'The disk is 90 % full.'
	);
	if (requested.kind !== 'requested') throw new Error(requested.message);
	return { ...setUp, requestId: requested.requestId };
}

describe('clean_up_storage asks (SPEC-MCP M53)', () => {
	it('M53: takes item ids from the fixed list only, each once', () => {
		const parse = (items: unknown) =>
			cleanUpStorageInput.safeParse({ machine: 'mint', items, reason: 'Full' }).success;
		expect(parse(['old-var-tmp', 'journal'])).toBe(true);
		expect(parse(['/var/tmp'])).toBe(false);
		expect(parse(['rm -rf /'])).toBe(false);
		expect(parse(['journal', 'journal'])).toBe(false);
		expect(parse([])).toBe(false);
	});

	it('M53: needs AI commands and Files; only items the machine offers', async () => {
		const viewer = await setUpStorageAssistant(['view', 'ai-view', 'files']);
		const machine = { id: viewer.machineId, name: 'test-machine' };
		expect(await requestCleanup(viewer.asking(), machine, ['old-var-tmp'], 'Full')).toMatchObject({
			kind: 'refused',
			message: expect.stringContaining('viewing only') as unknown
		});
		disconnectFakeAgents();
		const noFiles = await setUpStorageAssistant(['view', 'ai-view', 'ai-commands']);
		expect(
			await requestCleanup(
				noFiles.asking(),
				{ id: noFiles.machineId, name: 'test-machine' },
				['old-var-tmp'],
				'Full'
			)
		).toMatchObject({ message: expect.stringContaining('Files permission') as unknown });
		expect(noFiles.agent.requests).toEqual([]);
		disconnectFakeAgents();
		const asker = await setUpStorageAssistant(ASKS);
		const notOffered = await requestCleanup(
			asker.asking(),
			{ id: asker.machineId, name: 'test-machine' },
			['journal'],
			'Full'
		);
		expect(notOffered).toMatchObject({
			kind: 'refused',
			message: expect.stringContaining('journal is not offered') as unknown
		});
		expect(asker.agent.requests.map((request) => request.op)).toEqual(['storage-cleanup-sizes']);
	});

	it('M53: a request waits for approval, nothing starts, and it is audited via the assistant', async () => {
		const { database, agent, pat, requestId, asking, machineId } = await asked();
		expect(agent.requests.map((request) => request.op)).toEqual(['storage-cleanup-sizes']);
		expect(pendingCleanupsFor(database, pat).map((request) => request.id)).toEqual([requestId]);
		const entry = listAudit(database, 20).find(
			(found) => found.kind === 'storage-cleanup-requested'
		);
		expect(entry?.detail).toMatchObject({
			request: requestId,
			items: 'Old files in /var/tmp',
			total: '2.0 KB',
			reason: 'The disk is 90 % full.',
			via: 'Claude Code'
		});
		const second = await requestCleanup(
			asking(),
			{ id: machineId, name: 'test-machine' },
			['unused-flatpaks'],
			'More'
		);
		expect(second).toMatchObject({
			kind: 'refused',
			message: expect.stringContaining('already waits for approval') as unknown
		});
	});
});

describe('approving a clean-up (SPEC-MCP M54)', () => {
	it('M54: the Approvals page and card show the items, their sizes, the total and the reason', async () => {
		const { database, pat, requestId, deciding } = await asked();
		expect(approvalsNav(database, pat)).toEqual({ kind: 'shown', pending: 1 });
		const view = cleanupApprovalView(deciding(pat), requestId);
		expect(view).toMatchObject({
			requestId,
			requestedBy: pat.name,
			assistant: 'Claude Code',
			verified: true,
			reason: 'The disk is 90 % full.',
			items: [{ id: 'old-var-tmp', size: { kind: 'bytes', bytes: 2048, files: 3 } }],
			state: { kind: 'pending', decide: { kind: 'yes', signIn: { kind: 'recent' } } }
		});
	});

	it('M54: approving needs Files on the machine and a recent sign-in', async () => {
		const { kim, pat, admin, requestId, deciding, clock, database, machineId } = await asked();
		// Kim is not the person it acts as, nor (yet) an approver: the request looks missing.
		expect(await approveCleanupRequest(deciding(kim), requestId, NONE)).toMatchObject({
			kind: 'refused',
			status: 404
		});
		const groupId = done(
			createGroup(database, 'user', admin.id, { name: 'Approvers', description: '' }, NOW)
		);
		done(setGroupMembers(database, 'user', admin.id, groupId, [kim.id], NOW));
		writeApproverSettings(database, admin.id, { mode: 'requester-or-group', groupId }, NOW);
		grantAccess(database, {
			adminId: admin.id,
			name: 'Kim sees',
			memberIds: [kim.id],
			machineIds: [machineId],
			permissions: ['view'],
			consent: 'unattended'
		});
		expect(cleanupApprovalView(deciding(kim), requestId)?.state).toMatchObject({
			kind: 'pending',
			decide: { kind: 'no' }
		});
		expect(await approveCleanupRequest(deciding(kim), requestId, NONE)).toMatchObject({
			kind: 'refused',
			status: 403,
			message: expect.stringContaining('You cannot use files') as unknown
		});
		const signedIn = deciding(pat);
		clock.now += 11 * MINUTE;
		const late = await approveCleanupRequest({ ...signedIn, now: clock.now }, requestId, NONE);
		expect(late).toMatchObject({ kind: 'refused', status: 409 });
		expect(listAudit(database, 20).map((entry) => entry.kind)).toContain('storage-cleanup-expired');
	});

	it('M54: approval starts the clean-up on the approver’s files session, audited with who asked', async () => {
		const { pat, requestId, deciding, agent, database } = await asked();
		const approved = await approveCleanupRequest(deciding(pat), requestId, NONE);
		expect(approved).toMatchObject({ kind: 'approved', requestId });
		const start = agent.requests.find((request) => request.op === 'storage-cleanup-start');
		expect(start).toMatchObject({ items: ['old-var-tmp'] });
		const started = listAudit(database, 20).find(
			(entry) => entry.kind === 'storage-cleanup-started'
		);
		expect(started).toMatchObject({
			actorUserId: pat.id,
			detail: {
				items: 'Old files in /var/tmp',
				'requested by': pat.name,
				'asked via': 'Claude Code',
				reason: 'The disk is 90 % full.'
			}
		});
		expect(await approveCleanupRequest(deciding(pat), requestId, NONE)).toMatchObject({
			status: 409,
			message: `Already decided by ${pat.name}.`
		});
		expect(approvalsNav(database, pat)).toEqual({ kind: 'shown', pending: 0 });
	});

	it('M54: a machine already cleaning up leaves the request waiting', async () => {
		const { pat, requestId, deciding, agent, database } = await asked();
		agent.state.cleanupBusy = true;
		const busy = await approveCleanupRequest(deciding(pat), requestId, NONE);
		expect(busy).toMatchObject({ kind: 'refused', status: 503 });
		expect(pendingCleanupsFor(database, pat).map((request) => request.id)).toEqual([requestId]);
	});
});

describe('denied, expired and withdrawn clean-ups (SPEC-MCP M55)', () => {
	it('M55: a denial carries its note to the assistant; nothing starts', async () => {
		const { pat, requestId, deciding, agent, database, tools } = await asked();
		expect(denyCleanupRequest(deciding(pat), requestId, ' Not today ')).toEqual({
			kind: 'denied',
			requestId
		});
		expect(agent.requests.map((request) => request.op)).not.toContain('storage-cleanup-start');
		const result = await getCleanupResultTool(tools(), getCleanupResultInput.parse({ requestId }));
		expect(result).toMatchObject({
			kind: 'ok',
			output: { status: 'denied', denyNote: 'Not today', decidedBy: pat.name }
		});
		const denied = listAudit(database, 20).find((entry) => entry.kind === 'storage-cleanup-denied');
		expect(denied?.detail).toMatchObject({
			'requested by': pat.name,
			'asked via': 'Claude Code',
			note: 'Not today'
		});
	});

	it('M55: a request nobody decides expires after 10 minutes', async () => {
		const { requestId, database, tools, clock } = await asked();
		expect(expireCleanupRequests(database, clock.now + 9 * MINUTE)).toBe(0);
		expect(expireCleanupRequests(database, clock.now + 10 * MINUTE)).toBe(1);
		const result = await getCleanupResultTool(tools(), getCleanupResultInput.parse({ requestId }));
		expect(result).toMatchObject({ kind: 'ok', output: { status: 'expired' } });
		const expired = listAudit(database, 20).find(
			(entry) => entry.kind === 'storage-cleanup-expired'
		);
		expect(expired?.detail).toMatchObject({ via: 'Claude Code' });
	});

	it('M55: disconnecting the assistant withdraws its waiting clean-ups', async () => {
		const { requestId, database, pat, connection, clock, tools } = await asked();
		disconnectGrant(database, { userId: pat.id, admin: false }, connection.grantId, clock.now);
		expect(settleEndedGrantCleanups(database, clock.now)).toBe(1);
		expect(pendingCleanupsFor(database, pat)).toEqual([]);
		const withdrawn = listAudit(database, 20).find(
			(entry) => entry.kind === 'storage-cleanup-withdrawn'
		);
		expect(withdrawn?.detail).toMatchObject({ by: 'disconnect', request: requestId });
		expect(tools().principal.grantId).toBe(connection.grantId);
	});
});

describe('the result reaches the assistant (SPEC-MCP M56)', () => {
	it('M56: running, then the result per item, read from the machine and recorded once', async () => {
		const { pat, requestId, deciding, agent, database, tools, machineId } = await asked();
		const approved = await approveCleanupRequest(deciding(pat), requestId, NONE);
		const runId = approved.kind === 'approved' ? approved.runId : '';
		const running = await getCleanupResultTool(tools(), getCleanupResultInput.parse({ requestId }));
		expect(running).toMatchObject({
			kind: 'ok',
			output: {
				status: 'running',
				decidedBy: pat.name,
				items: [{ id: 'old-var-tmp', state: 'waiting', sizeWhenAskedBytes: 2048 }]
			}
		});
		agent.state.cleanupRun = {
			kind: 'finished',
			runId,
			startedAtMs: 1,
			finishedAtMs: 2,
			items: DONE
		};
		const finished = await getCleanupResultTool(
			tools(),
			getCleanupResultInput.parse({ requestId })
		);
		expect(finished).toMatchObject({
			kind: 'ok',
			output: {
				status: 'finished',
				items: [{ state: 'done', freedBytes: 2048, filesRemoved: 3, filesSkipped: 1, errors: 0 }],
				totals: { freedBytes: 2048, filesRemoved: 3, filesSkipped: 1, errors: 0 }
			}
		});
		expect(finished.kind === 'ok' && cleanupResultText(finished.output)).toContain(
			'Total: freed 2.0 KB, 3 files removed, 1 skipped, 0 errors.'
		);
		const row = database.select().from(storageCleanups).where(eq(storageCleanups.id, runId)).get();
		expect(row?.finishedAt).not.toBeNull();
		// The check-in arriving later records nothing twice.
		expect(
			recordCleanupResult(
				database,
				machineId,
				{ kind: 'finished', runId, startedAtMs: 1, finishedAtMs: 2, items: DONE },
				Date.now()
			)
		).toBe(false);
		expect(
			listAudit(database, 30).filter((entry) => entry.kind === 'storage-cleanup')
		).toHaveLength(1);
	});

	it('M56: clean_up_storage answers pending at first; another person’s request looks missing', async () => {
		const { tools, machineId, kim, database } = await setUpStorageAssistant(ASKS);
		const first = await cleanUpStorageTool(
			tools(),
			cleanUpStorageInput.parse({ machine: machineId, items: ['old-var-tmp'], reason: 'Full' })
		);
		expect(first).toMatchObject({
			kind: 'ok',
			output: {
				status: 'pending-approval',
				message: expect.stringContaining('Call get_cleanup_result') as unknown,
				totals: null
			}
		});
		const requestId = first.kind === 'ok' ? first.output.requestId : '';
		expect(first.kind === 'ok' && first.output.approvalUrl).toContain(
			`/approvals/clean-ups/${requestId}`
		);
		const someoneElse = { ...tools(), principal: { ...tools().principal, user: kim } };
		expect(
			await getCleanupResultTool(someoneElse, getCleanupResultInput.parse({ requestId }))
		).toMatchObject({ kind: 'error' });
		expect(pendingCleanupsFor(database, kim)).toEqual([]);
	});
});
