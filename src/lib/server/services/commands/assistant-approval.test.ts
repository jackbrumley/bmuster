import { codeFor, turnOnTwoFactor } from '#tests/helpers/two-factor.ts';
import { findUserById } from '../users/users.ts';
import { afterEach, describe, expect, it } from 'vitest';
import {
	cancelCommandInput,
	getCommandResultInput,
	runCommandInput
} from '#lib/schemas/mcp/tools.ts';
import { done } from '#tests/helpers/access.ts';
import {
	agentAnswers,
	asAsked,
	connect,
	disconnectAgents,
	MINUTE,
	setUpAssistantRuns
} from '#tests/helpers/assistant-runs.ts';
import { PASSWORD } from '#tests/helpers/people.ts';
import { createGroup, setGroupMembers } from '../access/groups.ts';
import { cancelCommandTool, getCommandResultTool, runCommandTool } from '../mcp/command-tools.ts';
import { disconnectGrant } from '../oauth/grants.ts';
import { writeApproverSettings } from '../oauth/mcp-settings.ts';
import { approvalViewFor, listApprovals } from './approval-views.ts';
import { settleEndedGrantRuns } from './assistant-pending.ts';
import { approveRun, denyRun } from './assistant-runs.ts';
import { cancelRun } from './commands.ts';
import { findRun, scriptsOf } from './command-runs.ts';

afterEach(disconnectAgents);

const ask = (machines: string[], command = 'uptime') =>
	runCommandInput.parse({ machines, shell: 'bash', command, reason: 'Check the load' });

/** Ada in an approvers group, with the setting at requester-or-group. Returns the group. */
function adaApproves(
	setUp: Pick<Awaited<ReturnType<typeof setUpAssistantRuns>>, 'database' | 'people' | 'clock'>
): string {
	const { database, people, clock } = setUp;
	const groupId = done(
		createGroup(
			database,
			'user',
			people.admin.id,
			{ name: 'Approvers', description: '' },
			clock.now
		)
	);
	done(setGroupMembers(database, 'user', people.admin.id, groupId, [people.admin.id], clock.now));
	writeApproverSettings(
		database,
		people.admin.id,
		{ mode: 'requester-or-group', groupId },
		clock.now
	);
	return groupId;
}

async function requested() {
	const setUp = await setUpAssistantRuns();
	const pat = await setUp.assistantOf('pat');
	const asked = await runCommandTool(setUp.tools(pat), ask(['mint']));
	if (asked.kind !== 'ok') throw new Error(asked.message);
	return { ...setUp, pat, runId: asked.output.runId };
}

describe('who may approve (SPEC-MCP M19)', () => {
	it('M19: by default only the person the assistant acts as; others cannot see it', async () => {
		const { consoleAs, runId } = await requested();
		expect(approvalViewFor(consoleAs('pat'), runId)).toMatchObject({
			runId,
			decide: { kind: 'yes', signIn: { kind: 'recent' } }
		});
		expect(approvalViewFor(consoleAs('admin'), runId)).toBeUndefined();
		expect(await approveRun(consoleAs('admin'), runId, asAsked('uptime', 60_000, 1))).toMatchObject(
			{ kind: 'refused', status: 404 }
		);
	});

	it('M19: requester-or-group and group-only add or replace the approvers group', async () => {
		const { database, people, consoleAs, runId, clock } = await requested();
		const groupId = adaApproves({ database, people, clock });
		expect(listApprovals(consoleAs('admin')).map((approval) => approval.runId)).toEqual([runId]);
		expect(listApprovals(consoleAs('pat')).map((approval) => approval.runId)).toEqual([runId]);
		writeApproverSettings(database, people.admin.id, { mode: 'group-only', groupId }, clock.now);
		expect(listApprovals(consoleAs('pat'))).toEqual([]);
		expect(await approveRun(consoleAs('pat'), runId, asAsked('uptime', 60_000, 1))).toMatchObject({
			kind: 'refused',
			status: 404
		});
		expect(await approveRun(consoleAs('admin'), runId, asAsked('uptime', 60_000, 1))).toEqual({
			kind: 'approved',
			runId
		});
	});

	it('M19: after 10 minutes from sign-in the password is needed (the same recent sign-in check)', async () => {
		const { consoleAs, clock, pat, tools } = await requested();
		clock.now += 9 * MINUTE;
		const asked = await runCommandTool(tools(pat), ask(['mint']));
		const runId = asked.kind === 'ok' ? asked.output.runId : '';
		clock.now += 2 * MINUTE;
		const later = consoleAs('pat');
		expect(approvalViewFor(later, runId)).toMatchObject({
			decide: { kind: 'yes', signIn: { kind: 'password' } }
		});
		expect(await approveRun(later, runId, asAsked('uptime', 60_000, 1))).toMatchObject({
			kind: 'refused',
			status: 403
		});
		expect(
			await approveRun(later, runId, {
				...asAsked('uptime', 60_000, 1),
				recheck: { kind: 'password', password: PASSWORD }
			})
		).toEqual({ kind: 'approved', runId });
	});

	it('SPEC-TWO-FACTOR TF13: with two-factor on, approving later takes an authenticator code', async () => {
		const { consoleAs, clock, pat, tools, database, people } = await requested();
		const row = findUserById(database, people.pat.id);
		if (row === undefined) throw new Error('no Pat');
		await turnOnTwoFactor(database, row, clock.now);
		clock.now += 9 * MINUTE;
		const asked = await runCommandTool(tools(pat), ask(['mint']));
		const runId = asked.kind === 'ok' ? asked.output.runId : '';
		clock.now += 2 * MINUTE;
		const later = consoleAs('pat');
		expect(approvalViewFor(later, runId)).toMatchObject({
			decide: { kind: 'yes', signIn: { kind: 'code' } }
		});
		expect(
			await approveRun(later, runId, {
				...asAsked('uptime', 60_000, 1),
				recheck: { kind: 'code', code: codeFor(database, people.pat.id, clock.now) }
			})
		).toEqual({ kind: 'approved', runId });
	});

	it('M19: the typed count must match the machines', async () => {
		const { consoleAs, runId } = await requested();
		expect(await approveRun(consoleAs('pat'), runId, asAsked('uptime', 60_000, 2))).toMatchObject({
			kind: 'refused',
			status: 400
		});
	});
});

describe('approve, deny, edit (SPEC-MCP M20)', () => {
	it('M20: deny with a note: nothing runs and the assistant reads the note', async () => {
		const { database, machine, consoleAs, runId, pat, tools, people } = await requested();
		const tickets = connect(machine.mint);
		expect(denyRun(consoleAs('pat'), runId, 'Not on a Friday')).toEqual({ kind: 'denied', runId });
		expect(tickets).toEqual([]);
		expect(findRun(database, runId)).toMatchObject({
			status: 'denied',
			denyNote: 'Not on a Friday'
		});
		expect(
			await getCommandResultTool(tools(pat), getCommandResultInput.parse({ runId, waitSeconds: 0 }))
		).toMatchObject({
			kind: 'ok',
			output: {
				status: 'denied',
				decidedBy: people.pat.name,
				denyNote: 'Not on a Friday',
				message: 'A person denied this request. Nothing ran. Their note: Not on a Friday'
			}
		});
	});

	it('M20: edit then approve: the run keeps both, and the assistant gets edited and what ran', async () => {
		const { database, relay, machine, consoleAs, runId, pat, tools } = await requested();
		const tickets = connect(machine.mint);
		expect(
			await approveRun(consoleAs('pat'), runId, asAsked('uptime --pretty', 30_000, 1))
		).toEqual({ kind: 'approved', runId });
		expect(tickets[0]?.purpose).toMatchObject({ command: 'uptime --pretty', timeoutMs: 30_000 });
		expect(scriptsOf(database, [runId])[0]).toMatchObject({
			command: 'uptime --pretty',
			requestedCommand: 'uptime'
		});
		expect(findRun(database, runId)).toMatchObject({
			timeoutMs: 30_000,
			requestedTimeoutMs: 60_000
		});
		const [ticket] = tickets;
		if (ticket !== undefined)
			agentAnswers(relay, ticket, { stdout: 'two', stderr: '', exitCode: 0 });
		expect(
			await getCommandResultTool(tools(pat), getCommandResultInput.parse({ runId, waitSeconds: 0 }))
		).toMatchObject({
			kind: 'ok',
			output: { status: 'finished', edited: true, commandRun: 'uptime --pretty' }
		});
	});

	it('M20: two decisions at once settle on one; the other sees who decided', async () => {
		const { database, people, consoleAs, runId, clock } = await requested();
		adaApproves({ database, people, clock });
		const [approved, denied] = await Promise.all([
			approveRun(consoleAs('pat'), runId, asAsked('uptime', 60_000, 1)),
			Promise.resolve(denyRun(consoleAs('admin'), runId, ''))
		]);
		const outcomes = [approved.kind, denied.kind].sort();
		expect(outcomes).toHaveLength(2);
		expect(outcomes.filter((kind) => kind === 'refused')).toHaveLength(1);
		const loser = approved.kind === 'refused' ? approved : denied;
		expect(loser).toMatchObject({
			status: 409,
			message: expect.stringMatching(/^Already decided by /u) as unknown
		});
	});
});

describe('expiry and withdrawal (SPEC-MCP M21)', () => {
	it('M21: a request expires after 10 minutes, cannot be approved, and the assistant is told', async () => {
		const { consoleAs, runId, clock, pat, tools } = await requested();
		clock.now += 10 * MINUTE + 1;
		expect(await approveRun(consoleAs('pat'), runId, asAsked('uptime', 60_000, 1))).toMatchObject({
			kind: 'refused',
			status: 409,
			message: 'This request expired without a decision. The assistant was told.'
		});
		expect(
			await getCommandResultTool(tools(pat), getCommandResultInput.parse({ runId, waitSeconds: 0 }))
		).toMatchObject({ kind: 'ok', output: { status: 'expired' } });
	});

	it('M21: cancel_command withdraws a pending request; on a started run it is Cancel run', async () => {
		const { database, consoleAs, runId, pat, tools } = await requested();
		expect(cancelCommandTool(tools(pat), cancelCommandInput.parse({ runId }))).toMatchObject({
			kind: 'ok',
			output: { status: 'cancelled' }
		});
		expect(findRun(database, runId)?.status).toBe('cancelled');
		expect(await approveRun(consoleAs('pat'), runId, asAsked('uptime', 60_000, 1))).toMatchObject({
			kind: 'refused',
			message: 'This request was withdrawn.'
		});
		const asked = await runCommandTool(tools(pat), ask(['mint', 'reception']));
		const started = asked.kind === 'ok' ? asked.output.runId : '';
		await approveRun(consoleAs('pat'), started, asAsked('uptime', 60_000, 2));
		expect(
			cancelCommandTool(tools(pat), cancelCommandInput.parse({ runId: started }))
		).toMatchObject({ kind: 'ok' });
	});

	it('M21: a person can cancel a pending request from its page', async () => {
		const { database, consoleAs, runId } = await requested();
		expect(cancelRun(consoleAs('pat'), runId)).toEqual({ kind: 'cancelled', notStarted: 1 });
		expect(findRun(database, runId)?.status).toBe('cancelled');
	});

	it('M21: disconnecting the assistant cancels its pending requests', async () => {
		const { database, runner, people, runId, pat, clock } = await requested();
		disconnectGrant(database, { userId: people.pat.id, admin: false }, pat.grantId, clock.now);
		expect(settleEndedGrantRuns({ database, runner, now: clock.now })).toBe(1);
		expect(findRun(database, runId)?.status).toBe('cancelled');
	});
});
