import { describe, expect, it } from 'vitest';
import { listMachinesInput } from '#lib/schemas/mcp/tools.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent, NO_RELEASES, testDatabase } from '#tests/helpers/fake-agent.ts';
import { connectAssistant, enableMcp } from '#tests/helpers/mcp.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { listAudit } from '../audit/audit.ts';
import { disconnectGrant } from '../oauth/grants.ts';
import { authenticateAccessToken } from '../oauth/tokens.ts';
import { activityFeed } from '../users/activity-feed.ts';
import { getMachineTool, listMachinesTool } from './machine-tools.ts';

async function setUp() {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: null
	});
	const jack = await addTestUser(database, {
		email: 'jack@example.com',
		role: 'member',
		password: null
	});
	const machineId = enrolFakeAgent(database, NOW).machineId;
	grantAccess(database, {
		adminId: admin.id,
		name: 'AI',
		memberIds: [jack.id],
		machineIds: [machineId],
		permissions: ['view', 'ai-commands'],
		consent: 'unattended'
	});
	enableMcp(database, admin.id, [jack.id]);
	return { database, admin, jack, machineId };
}

function principalFor(database: ReturnType<typeof testDatabase>, accessToken: string) {
	const check = authenticateAccessToken(database, accessToken, { ip: '::1', userAgent: '' }, NOW);
	if (check.kind !== 'valid') throw new Error('token refused');
	return check.principal;
}

describe('attribution (SPEC-MCP M13)', () => {
	it('M13: tool calls are audited as the person, via the assistant, shown "jack via Claude Code"', async () => {
		const { database, jack, machineId } = await setUp();
		const connection = await connectAssistant(database, jack.id, 'claude-code', NOW);
		const context = {
			database,
			releases: NO_RELEASES,
			now: NOW,
			principal: principalFor(database, connection.accessToken)
		};
		listMachinesTool(context, listMachinesInput.parse({}));
		getMachineTool(context, { machine: machineId });
		const [machineRead, listRead] = listAudit(database, 2);
		expect(machineRead).toMatchObject({
			kind: 'mcp-tool-called',
			actorUserId: jack.id,
			machineId,
			detail: {
				tool: 'get_machine',
				via: 'Claude Code',
				viaClientId: 'https://claude.ai/oauth/claude-code-client-metadata',
				viaVerified: 'yes'
			}
		});
		expect(listRead).toMatchObject({ kind: 'mcp-tool-called', detail: { tool: 'list_machines' } });
		const feed = activityFeed(database, { kind: 'all' }, 1);
		expect(feed[0]?.actor).toEqual({ kind: 'user', name: 'jack via Claude Code' });
		expect(feed[0]?.detail.map((line) => line.label)).toEqual(['tool']);
	});

	it('M13: an unverified client is named "unverified client …"', async () => {
		const { database, jack } = await setUp();
		const connection = await connectAssistant(database, jack.id, 'registered', NOW);
		listMachinesTool(
			{
				database,
				releases: NO_RELEASES,
				now: NOW,
				principal: principalFor(database, connection.accessToken)
			},
			listMachinesInput.parse({})
		);
		expect(activityFeed(database, { kind: 'all' }, 1)[0]?.actor).toEqual({
			kind: 'user',
			name: 'jack via unverified client Helper bot'
		});
	});

	it('M13: consent and disconnection are audited with the assistant named', async () => {
		const { database, jack } = await setUp();
		const connection = await connectAssistant(database, jack.id, 'claude-code', NOW);
		disconnectGrant(database, { userId: jack.id, admin: false }, connection.grantId, NOW);
		const kinds = listAudit(database, 10).filter((entry) => entry.kind.startsWith('mcp-'));
		expect(kinds.map((entry) => [entry.kind, entry.target, entry.detail['reason']])).toEqual([
			['mcp-grant-ended', 'Claude Code', 'disconnected'],
			['mcp-client-allowed', 'Claude Code', undefined]
		]);
	});
});
