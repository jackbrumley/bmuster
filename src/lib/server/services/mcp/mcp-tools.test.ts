import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
	getMachineInput,
	getMachineOutput,
	listMachinesInput,
	listMachinesOutput
} from '#lib/schemas/mcp/tools.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import {
	enrolFakeAgent,
	NO_RELEASES,
	SAMPLE_INVENTORY,
	testDatabase
} from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { machineInventory, machines } from '../../database/schema.ts';
import { removeMachine } from '../machines/machine-views.ts';
import { toConsoleUser } from '../users/users.ts';
import { getMachineTool, listMachinesTool, type ToolContext } from './machine-tools.ts';

async function setUp() {
	const database = testDatabase();
	const admin = toConsoleUser(
		await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: null })
	);
	const pat = toConsoleUser(
		await addTestUser(database, { email: 'pat@example.com', role: 'member', password: null })
	);
	const named = (name: string) => {
		const id = enrolFakeAgent(database, NOW).machineId;
		database.update(machines).set({ name, hostname: name }).where(eq(machines.id, id)).run();
		return id;
	};
	const mint = named('mint');
	const reception = named('reception');
	const payroll = named('payroll');
	database
		.insert(machineInventory)
		.values({
			machineId: mint,
			hash: 'a'.repeat(64),
			data: JSON.stringify(SAMPLE_INVENTORY),
			updatedAt: new Date(NOW)
		})
		.run();
	grantAccess(database, {
		adminId: admin.id,
		name: 'AI',
		memberIds: [pat.id, admin.id],
		machineIds: [mint, reception],
		permissions: ['view', 'ai-commands'],
		consent: 'unattended'
	});
	grantAccess(database, {
		adminId: admin.id,
		name: 'Payroll',
		memberIds: [pat.id],
		machineIds: [payroll],
		permissions: ['view', 'terminal', 'run-commands'],
		consent: 'unattended'
	});
	const context = (user: typeof pat, scopes: ToolContext['principal']['scopes']): ToolContext => ({
		database,
		releases: NO_RELEASES,
		now: NOW,
		principal: {
			user,
			grantId: crypto.randomUUID(),
			scopes,
			assistant: { name: 'Claude Code', identity: { kind: 'verified', host: 'claude.ai' } },
			clientId: 'https://claude.ai/oauth/claude-code-client-metadata'
		}
	});
	return { database, admin, pat, mint, reception, payroll, context };
}

const all = listMachinesInput.parse({});

describe('read tools (SPEC-MCP M11)', () => {
	it('M11: list_machines shows only machines where the person holds ai-commands', async () => {
		const { context, pat, admin } = await setUp();
		const listed = listMachinesTool(context(pat, ['machines:read']), all);
		if (listed.kind !== 'ok') throw new Error(listed.message);
		expect(listMachinesOutput.parse(listed.output).machines.map((machine) => machine.name)).toEqual(
			['mint', 'reception']
		);
		// Admins see nothing an AI rule does not open, even with every other permission.
		const adminListed = listMachinesTool(context(admin, ['machines:read']), all);
		expect(adminListed.kind === 'ok' && adminListed.output.total).toBe(2);
	});

	it('M11: search, status and limit narrow the list; total counts every match', async () => {
		const { context, pat } = await setUp();
		const searched = listMachinesTool(
			context(pat, ['machines:read']),
			listMachinesInput.parse({ search: 'MIN', limit: 1 })
		);
		expect(searched).toMatchObject({ kind: 'ok', output: { total: 1 } });
		const offline = listMachinesTool(
			context(pat, ['machines:read']),
			listMachinesInput.parse({ status: 'offline' })
		);
		expect(offline).toMatchObject({ kind: 'ok', output: { total: 0, machines: [] } });
		const limited = listMachinesTool(
			context(pat, ['machines:read']),
			listMachinesInput.parse({ limit: 1 })
		);
		expect(limited).toMatchObject({ kind: 'ok', output: { total: 2 } });
		expect(limited.kind === 'ok' && limited.output.machines).toHaveLength(1);
	});

	it('M11: removed machines are left out', async () => {
		const { context, pat, admin, reception, database } = await setUp();
		removeMachine(database, reception, admin.id, NOW);
		const listed = listMachinesTool(context(pat, ['machines:read']), all);
		expect(listed.kind === 'ok' && listed.output.machines.map((machine) => machine.name)).toEqual([
			'mint'
		]);
	});

	it('M11: get_machine by id or unique name returns inventory; others are a readable tool error', async () => {
		const { context, pat, mint, payroll } = await setUp();
		const byName = getMachineTool(
			context(pat, ['machines:read']),
			getMachineInput.parse({ machine: 'Mint' })
		);
		if (byName.kind !== 'ok') throw new Error(byName.message);
		const parsed = getMachineOutput.parse(byName.output);
		expect(parsed).toMatchObject({ id: mint, name: 'mint', os: 'linux', shells: ['bash', 'sh'] });
		expect(parsed.disks.length).toBeGreaterThan(0);
		expect(parsed.memory.totalBytes).toBe(SAMPLE_INVENTORY.memoryTotalBytes);
		expect(getMachineTool(context(pat, ['machines:read']), { machine: mint }).kind).toBe('ok');
		expect(getMachineTool(context(pat, ['machines:read']), { machine: payroll })).toMatchObject({
			kind: 'error'
		});
		expect(getMachineTool(context(pat, ['machines:read']), { machine: 'payroll' })).toMatchObject({
			kind: 'error'
		});
	});

	it('M11: a token without machines:read reads nothing', async () => {
		const { context, pat } = await setUp();
		expect(listMachinesTool(context(pat, ['offline_access']), all).kind).toBe('error');
	});
});

describe('never exposed (SPEC-MCP M12)', () => {
	it('M12: no output field could carry a code, secret, key, ticket, token, note or email address', () => {
		const schemas = {
			list_machines: z.toJSONSchema(listMachinesOutput),
			get_machine: z.toJSONSchema(getMachineOutput)
		};
		const keys = JSON.stringify(schemas).match(/"([A-Za-z]+)":/g) ?? [];
		const forbidden = /code|secret|key|ticket|token|note|email|password|share|link/i;
		expect(keys.filter((key) => forbidden.test(key) && key !== '"additionalProperties":')).toEqual(
			[]
		);
		expect(schemas).toMatchSnapshot();
	});

	it('M12: a member’s output carries no group names (members never see groups)', async () => {
		const { context, pat, admin } = await setUp();
		const member = listMachinesTool(context(pat, ['machines:read']), all);
		expect(member.kind === 'ok' && member.output.machines.every((m) => m.groups.length === 0)).toBe(
			true
		);
		const adminView = listMachinesTool(context(admin, ['machines:read']), all);
		expect(adminView.kind === 'ok' && adminView.output.machines[0]?.groups).toContain(
			'All machines'
		);
	});
});
