import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import {
	activityExportQuerySchema,
	machinesExportQuerySchema
} from '#lib/schemas/exports/exports.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent, NO_RELEASES, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { auditEntries } from '../../database/schema.ts';
import { listAudit, recordAudit } from '../audit/audit.ts';
import { updateMachineDetails } from '../machines/machine-details.ts';
import { toConsoleUser } from '../users/users.ts';
import type { CsvCell } from './csv.ts';
import {
	ACTIVITY_EXPORT_CAP,
	exportAccessRules,
	exportActivity,
	exportGroups,
	exportMachines,
	exportUsers
} from './exports.ts';

const DAY = 86_400_000;

function named(database: AppDatabase, adminId: string, enrolledAt: number, name: string): string {
	const id = enrolFakeAgent(database, enrolledAt).machineId;
	updateMachineDetails(database, id, { name, description: `${name} notes` }, adminId, enrolledAt);
	return id;
}

/**
 * Ada (admin) and Pat (member). Three machines: Reception PC and Build server
 * checked in now, Office laptop a day ago (offline). Pat sees the first two
 * through the Front desk group and rule.
 */
async function setUp() {
	const database = testDatabase();
	const admin = toConsoleUser(
		await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: null })
	);
	const pat = toConsoleUser(
		await addTestUser(database, { email: 'pat@example.com', role: 'member', password: null })
	);
	const reception = named(database, admin.id, NOW, 'Reception PC');
	const build = named(database, admin.id, NOW, 'Build server');
	const laptop = named(database, admin.id, NOW - DAY, 'Office laptop');
	grantAccess(database, {
		adminId: admin.id,
		name: 'Front desk',
		memberIds: [pat.id],
		machineIds: [reception, build],
		permissions: ['view', 'terminal'],
		consent: 'ask'
	});
	return { database, admin, pat, reception, build, laptop };
}

function machinesQuery(params: Record<string, string>) {
	return machinesExportQuerySchema.parse(params);
}

function column(header: readonly string[], rows: readonly (readonly CsvCell[])[], name: string) {
	const index = header.indexOf(name);
	if (index === -1) throw new Error(`no column ${name}`);
	return rows.map((row) => row[index]);
}

function lastExportAudit(database: AppDatabase) {
	const [entry] = listAudit(database, 1);
	if (entry === undefined) throw new Error('nothing audited');
	return entry;
}

describe('Machines export (X5, X6)', () => {
	it('X5: lists every machine for an admin, with groups; a member gets only theirs, without groups', async () => {
		const { database, admin, pat } = await setUp();
		const all = exportMachines(database, admin, machinesQuery({}), NOW, NO_RELEASES);
		expect(all.header).toEqual([
			'Name',
			'Host',
			'Status',
			'OS',
			'OS version',
			'CPU %',
			'Memory %',
			'Disk % (fullest)',
			'Last user',
			'Last seen',
			'Groups',
			'Agent version',
			'Description'
		]);
		expect(column(all.header, all.rows, 'Name')).toEqual([
			'Build server',
			'Office laptop',
			'Reception PC'
		]);
		expect(column(all.header, all.rows, 'Groups')).toEqual([
			'Front desk machines',
			'',
			'Front desk machines'
		]);
		expect(all.rows[0]).toEqual([
			'Build server',
			'test-host',
			'Online',
			'Linux',
			null,
			null,
			null,
			null,
			null,
			new Date(NOW).toISOString(),
			'Front desk machines',
			'0.1.0',
			'Build server notes'
		]);

		const mine = exportMachines(database, pat, machinesQuery({}), NOW, NO_RELEASES);
		expect(mine.header).not.toContain('Groups');
		expect(column(mine.header, mine.rows, 'Name')).toEqual(['Build server', 'Reception PC']);
	});

	it('X5: a member with no access exports a header and no rows', async () => {
		const { database } = await setUp();
		const nobody = toConsoleUser(
			await addTestUser(database, { email: 'new@example.com', role: 'member', password: null })
		);
		const none = exportMachines(database, nobody, machinesQuery({}), NOW, NO_RELEASES);
		expect(none.rows).toEqual([]);
		expect(none.header[0]).toBe('Name');
	});

	it('X6: applies the search and filter to every machine, not just a drawn batch', async () => {
		const { database, admin, pat } = await setUp();
		const names = (user: ConsoleUser, params: Record<string, string>) => {
			const result = exportMachines(database, user, machinesQuery(params), NOW, NO_RELEASES);
			return column(result.header, result.rows, 'Name');
		};
		expect(names(admin, { search: 'BUILD' })).toEqual(['Build server']);
		expect(names(admin, { search: 'notes' })).toHaveLength(3);
		expect(names(admin, { filter: 'offline' })).toEqual(['Office laptop']);
		expect(names(admin, { filter: 'online' })).toEqual(['Build server', 'Reception PC']);
		// A filter never widens what the member may see.
		expect(names(pat, { filter: 'offline' })).toEqual([]);
		expect(names(pat, { search: 'laptop' })).toEqual([]);
	});

	it("X6: keeps the table's sort, or the list order in Cards view", async () => {
		const { database, admin } = await setUp();
		const names = (params: Record<string, string>) => {
			const result = exportMachines(database, admin, machinesQuery(params), NOW, NO_RELEASES);
			return column(result.header, result.rows, 'Name');
		};
		expect(names({ sort: 'name', direction: 'desc' })).toEqual([
			'Reception PC',
			'Office laptop',
			'Build server'
		]);
		// Last seen: online machines count as seen now, so the offline laptop sorts first ascending.
		expect(names({ sort: 'lastSeen', direction: 'asc' })[0]).toBe('Office laptop');
		expect(names({})).toEqual(['Build server', 'Office laptop', 'Reception PC']);
	});

	it('refuses an unknown filter or sort column', () => {
		expect(machinesExportQuerySchema.safeParse({ filter: 'everything' }).success).toBe(false);
		expect(machinesExportQuerySchema.safeParse({ sort: 'secret' }).success).toBe(false);
	});

	it('X8: audits who exported Machines, how many rows, and the search, filter and sort', async () => {
		const { database, pat } = await setUp();
		const result = exportMachines(
			database,
			pat,
			machinesQuery({ search: 'pc', filter: 'online', sort: 'cpu', direction: 'desc' }),
			NOW + 5,
			NO_RELEASES
		);
		expect(result.filename).toMatch(/^bmuster-machines-\d{4}-\d{2}-\d{2}\.csv$/);
		expect(lastExportAudit(database)).toMatchObject({
			actorUserId: pat.id,
			kind: 'list-exported',
			target: 'Machines',
			detail: { rows: '1', search: 'pc', filter: 'online', sort: 'cpu desc' }
		});
	});
});

describe('admin lists (X5)', () => {
	it('Users: name, email, role, sign-in method, groups, last sign-in, disabled', async () => {
		const { database, admin } = await setUp();
		const result = exportUsers(database, admin, NOW);
		expect(result.header).toEqual([
			'Name',
			'Email',
			'Role',
			'Sign-in method',
			'Groups',
			'Last sign-in',
			'Disabled'
		]);
		expect(result.rows).toEqual([
			['ada', 'ada@example.com', 'Admin', 'Not signed in yet', '', null, 'No'],
			['pat', 'pat@example.com', 'Member', 'Not signed in yet', 'Front desk', null, 'No']
		]);
		expect(lastExportAudit(database)).toMatchObject({ target: 'Users', detail: { rows: '2' } });
	});

	it('Groups: people groups, then machine groups with All machines holding every machine', async () => {
		const { database, admin } = await setUp();
		const result = exportGroups(database, admin, NOW);
		expect(result.header).toEqual(['Name', 'Kind', 'Member count', 'Members']);
		expect(result.rows).toEqual([
			['Front desk', 'People', 1, 'pat'],
			['All machines', 'Machines', 3, 'Build server; Office laptop; Reception PC'],
			['Front desk machines', 'Machines', 2, 'Build server; Reception PC']
		]);
	});

	it('Access rules: who, what machines, permissions and consent', async () => {
		const { database, admin } = await setUp();
		const result = exportAccessRules(database, admin, NOW);
		expect(result.header).toEqual(['Who', 'What machines', 'Permissions', 'Consent']);
		expect(result.rows).toEqual([
			[
				'Front desk',
				'Front desk machines',
				'See inventory; Terminal',
				'Asks the person at the screen first'
			]
		]);
		expect(lastExportAudit(database)).toMatchObject({
			target: 'Access rules',
			detail: { rows: '1' }
		});
	});
});

describe('Activity export (X5, X7)', () => {
	const activityQuery = (params: Record<string, string>) => activityExportQuerySchema.parse(params);

	it('X7: newest first, with ISO and local time, actor, action, target, IP and details', async () => {
		const { database, admin } = await setUp();
		recordAudit(
			database,
			{
				actor: { kind: 'user', userId: admin.id },
				kind: 'sign-in',
				target: 'ada@example.com',
				machineId: null,
				detail: { method: 'password', ip: '192.0.2.10' }
			},
			Date.parse('2026-11-07T01:30:00.000Z')
		);
		const result = exportActivity(
			database,
			admin,
			activityQuery({ timeZone: 'Australia/Melbourne' }),
			Date.parse('2026-11-07T02:00:00.000Z')
		);
		expect(result.header).toEqual([
			'Time (ISO)',
			'Time (local, Australia/Melbourne)',
			'Actor',
			'Action',
			'Target',
			'IP',
			'Details'
		]);
		expect(result.rows[0]).toEqual([
			'2026-11-07T01:30:00.000Z',
			'2026-11-07 12:30:00',
			'ada',
			'Signed in',
			'ada@example.com',
			'192.0.2.10',
			'method: password'
		]);
	});

	it('X5: a member gets only entries about machines they can see', async () => {
		const { database, pat } = await setUp();
		const result = exportActivity(database, pat, activityQuery({}), NOW + 1);
		const targets = column(result.header, result.rows, 'Target');
		expect(targets.length).toBeGreaterThan(0);
		expect(targets).not.toContain('Office laptop');
		expect(targets).not.toContain('Front desk');
	});

	it('X7: keeps to the date range, and audits it', async () => {
		const { database, admin } = await setUp();
		const result = exportActivity(
			database,
			admin,
			activityQuery({
				from: new Date(NOW - DAY - 1).toISOString(),
				to: new Date(NOW - DAY + 1).toISOString()
			}),
			NOW + 10
		);
		// Only the laptop's enrolment, rename and description, a day ago.
		expect(column(result.header, result.rows, 'Target').toSorted()).toEqual([
			'Office laptop',
			'Office laptop',
			'Test machine'
		]);
		expect(lastExportAudit(database)).toMatchObject({
			actorUserId: admin.id,
			target: 'Activity',
			detail: {
				rows: '3',
				timeZone: 'UTC',
				from: new Date(NOW - DAY - 1).toISOString(),
				to: new Date(NOW - DAY + 1).toISOString()
			}
		});
		expect(activityExportQuerySchema.safeParse({ timeZone: 'Mars/Olympus' }).success).toBe(false);
		expect(activityExportQuerySchema.safeParse({ from: 'yesterday' }).success).toBe(false);
	});

	// 100 000 rows take a few seconds to export; a busy test run needs more than the default 5.
	it(
		`X7: stops at ${String(ACTIVITY_EXPORT_CAP)} rows and says so on the last line`,
		{ timeout: 30_000 },
		async () => {
			const { database, admin } = await setUp();
			const start = NOW - 2 * DAY;
			// One statement for the 100 000 rows, so seeding takes milliseconds.
			database.run(sql`
			with recursive n(i) as (select 0 union all select i + 1 from n where i < ${ACTIVITY_EXPORT_CAP - 1})
			insert into ${auditEntries} (id, at, actor_user_id, kind, target, machine_id, detail)
			select 'seed-' || i, ${start} + i, null, 'setting-changed', 'setting ' || i, null, '{}' from n`);
			const result = exportActivity(database, admin, activityQuery({}), NOW + 10);
			expect(result.rows).toHaveLength(ACTIVITY_EXPORT_CAP + 1);
			expect(String(result.rows.at(-1)?.[0])).toMatch(
				/^Cut off at 100000 rows: older entries than /
			);
			expect(lastExportAudit(database)).toMatchObject({
				target: 'Activity',
				detail: { rows: String(ACTIVITY_EXPORT_CAP), cutOff: 'yes' }
			});
		}
	);
});
