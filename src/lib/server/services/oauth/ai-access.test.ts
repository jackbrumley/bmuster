import { describe, expect, it } from 'vitest';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { listAudit } from '../audit/audit.ts';
import { listAccessRules } from '../access/rules.ts';
import { aiAccessView, grantAiAccess } from './ai-access.ts';
import { readMcpSettings, writeMcpSettings } from './mcp-settings.ts';

/** A server with three machines and a connect group whose rule opens one to AI commands. */
async function setUp() {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: null
	});
	const pat = await addTestUser(database, {
		email: 'pat@example.com',
		role: 'member',
		password: null
	});
	const machines = [0, 1, 2].map(() => enrolFakeAgent(database, NOW).machineId);
	const first = machines[0] ?? '';
	const rule = grantAccess(database, {
		adminId: admin.id,
		name: 'AI people',
		memberIds: [pat.id],
		machineIds: [first],
		permissions: ['view', 'ai-view', 'ai-commands'],
		consent: 'unattended'
	});
	return { database, admin, pat, machines, rule };
}

describe('what the AI can reach (SPEC-SAVED-COMMANDS SC24)', () => {
	it('SC24: counted from the connect group’s rules; nothing to show while no group is chosen', async () => {
		const { database, admin, rule } = await setUp();
		expect(aiAccessView(database)).toEqual({ kind: 'no-group' });
		writeMcpSettings(database, admin.id, { enabled: true, userGroupId: rule.userGroupId }, NOW);
		expect(aiAccessView(database)).toEqual({
			kind: 'group',
			canView: 1,
			canAsk: 1,
			viewsAll: false,
			asksAll: false
		});
	});
});

describe('one-tap rules (SC25)', () => {
	it('SC25: AI can view on All machines, then AI commands, through the rules service and audited', async () => {
		const { database, admin, rule } = await setUp();
		expect(grantAiAccess(database, admin.id, 'view', NOW)).toMatchObject({
			kind: 'refused',
			status: 400
		});
		writeMcpSettings(database, admin.id, { enabled: true, userGroupId: rule.userGroupId }, NOW);
		expect(grantAiAccess(database, admin.id, 'view', NOW)).toEqual({ kind: 'done' });
		expect(aiAccessView(database)).toEqual({
			kind: 'group',
			canView: 3,
			canAsk: 1,
			viewsAll: true,
			asksAll: false
		});
		const viewRule = listAccessRules(database).find(
			(entry) =>
				entry.userGroupId === rule.userGroupId && entry.machineGroupId !== rule.machineGroupId
		);
		expect(viewRule?.permissions).toEqual(['view', 'ai-view']);
		expect(listAudit(database, 1)[0]).toMatchObject({
			kind: 'access-rule-added',
			actorUserId: admin.id,
			target: 'AI people → All machines'
		});

		expect(grantAiAccess(database, admin.id, 'commands', NOW)).toEqual({ kind: 'done' });
		expect(aiAccessView(database)).toEqual({
			kind: 'group',
			canView: 3,
			canAsk: 3,
			viewsAll: true,
			asksAll: true
		});
		// One rule per pair: the same rule gained AI commands.
		const rules = listAccessRules(database).filter(
			(entry) => entry.userGroupId === rule.userGroupId
		);
		expect(rules).toHaveLength(2);
		expect(rules.find((entry) => entry.id === viewRule?.id)?.permissions).toEqual([
			'view',
			'ai-view',
			'ai-commands'
		]);
		expect(listAudit(database, 1)[0]).toMatchObject({ kind: 'access-rule-changed' });
		expect(readMcpSettings(database).enabled).toBe(true);
	});
});
