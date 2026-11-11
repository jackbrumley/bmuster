import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import {
	activityExportQuerySchema,
	machinesExportQuerySchema
} from '#lib/schemas/exports/exports.ts';
import type { InventoryWire } from '#lib/schemas/agents/agent-protocol.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import {
	enrolFakeAgent,
	NO_RELEASES,
	SAMPLE_INVENTORY,
	testDatabase
} from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { auditEntries } from '../../database/schema.ts';
import { recordCheckIn } from '../agents/check-in.ts';
import { listAudit, recordAudit } from '../audit/audit.ts';
import { updateMachineDetails } from '../machines/machine-details.ts';
import { toConsoleUser } from '../users/users.ts';
import { csvLine, type CsvCell } from './csv.ts';
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

/** A check-in from the machine with this inventory, with sarah.k signed in. */
function checkInWith(database: AppDatabase, machineId: string, data: InventoryWire, at: number) {
	recordCheckIn(
		database,
		{ machineId, checkInSeconds: 60 },
		{
			agentVersion: '0.1.0',
			uptimeSeconds: 60,
			update: { kind: 'no-launcher' },
			signedInUser: { kind: 'user', name: 'sarah.k' },
			load: { cpuPercent: 5, memoryUsedBytes: 1024 },
			inventory: { kind: 'full', hash: 'b'.repeat(64), data },
			localUsers: { kind: 'unsupported' },
			checks: { kind: 'unreported' }
		},
		at
	);
}

/** Two graphics cards, three disks and two network adapters. */
const FULL_INVENTORY: InventoryWire = {
	...SAMPLE_INVENTORY,
	disks: [
		{ mount: '/', sizeBytes: 500 * 1024 ** 3, usedBytes: 200 * 1024 ** 3 },
		{ mount: '/home', sizeBytes: 2 * 1024 ** 4, usedBytes: 1024 ** 4 },
		{ mount: '/boot/efi', sizeBytes: 512 * 1024 ** 2, usedBytes: 6 * 1024 ** 2 }
	],
	network: [
		{ name: 'eth0', mac: '00:11:22:33:44:55', addresses: ['10.0.0.5', 'fe80::1'] },
		{ name: 'wlan0', mac: '66:77:88:99:aa:bb', addresses: ['192.168.1.20'] }
	]
};

const DETAIL_COLUMNS = [
	'Agent update',
	'Enrolled',
	'Signed in',
	'In use',
	'Last user seen',
	'Memory used',
	'Pending updates',
	'OS build',
	'Processor',
	'Cores',
	'Memory total',
	'Graphics',
	'Disks',
	'Addresses',
	'Display'
];

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
			'Description',
			...DETAIL_COLUMNS
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
			'Build server notes',
			// X11: no inventory yet, so every inventory cell is empty.
			null,
			new Date(NOW).toISOString(),
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null
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

	it('X9: header order: the first columns stay put, then every Overview fact', async () => {
		const { database, admin, pat } = await setUp();
		const all = exportMachines(database, admin, machinesQuery({}), NOW, NO_RELEASES);
		expect(all.header.slice(0, 13)).toEqual([
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
		expect(all.header.slice(13)).toEqual(DETAIL_COLUMNS);
		// X12: a member gets the same detail columns (they see the same Overview), only no Groups.
		const mine = exportMachines(database, pat, machinesQuery({}), NOW, NO_RELEASES);
		expect(mine.header).toEqual(all.header.filter((name) => name !== 'Groups'));
		expect(all.rows.map((row) => row.length)).toEqual([28, 28, 28]);
		expect(mine.rows.map((row) => row.length)).toEqual([27, 27]);
	});

	it('X10: a fully inventoried machine: two graphics cards, several disks and adapters', async () => {
		const { database, admin, reception } = await setUp();
		checkInWith(database, reception, FULL_INVENTORY, NOW + 1000);
		const result = exportMachines(
			database,
			admin,
			machinesQuery({ search: 'reception' }),
			NOW + 2000,
			NO_RELEASES
		);
		const [row] = result.rows;
		if (row === undefined) throw new Error('no row');
		const detail = Object.fromEntries(result.header.map((name, index) => [name, row[index]]));
		expect(detail).toMatchObject({
			OS: 'Ubuntu',
			'OS version': '24.04',
			'Disk % (fullest)': 50,
			'Last user': 'sarah.k',
			'Agent update': null,
			Enrolled: new Date(NOW).toISOString(),
			'Signed in': 'sarah.k',
			'In use': null,
			'Last user seen': new Date(NOW + 1000).toISOString(),
			'Memory used': '1.0 KB',
			'Pending updates': 3,
			'OS build': '6.8.0',
			Processor: 'Test CPU',
			Cores: 8,
			'Memory total': '16.0 GB',
			Graphics: 'NVIDIA GeForce RTX 4070 (12 GB); Intel UHD Graphics 770',
			Disks:
				'/ 200 GB of 500 GB (40%); /home 1.0 TB of 2.0 TB (50%); /boot/efi 6.0 MB of 512 MB (1%)',
			Addresses: '10.0.0.5; fe80::1; 192.168.1.20',
			Display:
				'Session: wayland (user, active) · GNOME; card1: i915 · HDMI-A-1 2560x1440; ' +
				'uinput: Device yes, module yes; NVIDIA modeset: Y; Desktop portal: Yes; ' +
				'GStreamer: Yes, pipewiresrc present; Kernel: 6.8.0-45-generic; SELinux: Not enabled; ' +
				'Agent: v0.4.0, launcher v0.4.0'
		});
	});

	it('X11: no inventory yet: inventory cells stay empty; live figures empty while offline', async () => {
		const { database, admin, laptop } = await setUp();
		// The laptop reported its inventory a day ago and has been offline since.
		checkInWith(database, laptop, FULL_INVENTORY, NOW - DAY);
		const result = exportMachines(database, admin, machinesQuery({}), NOW, NO_RELEASES);
		const detailOf = (name: string) => {
			const row = result.rows.find((cells) => cells[0] === name);
			if (row === undefined) throw new Error(`no row ${name}`);
			return Object.fromEntries(result.header.map((header, index) => [header, row[index]]));
		};
		const fresh = detailOf('Reception PC');
		for (const name of DETAIL_COLUMNS.filter((header) => header !== 'Enrolled')) {
			expect(fresh[name], name).toBeNull();
		}
		const offline = detailOf('Office laptop');
		expect(offline['Status']).toBe('Offline');
		expect(offline['Memory used']).toBeNull();
		expect(offline['Processor']).toBe('Test CPU');
	});

	it('X12: hardware names with commas and quotes are quoted in the file', async () => {
		const { database, admin, build } = await setUp();
		checkInWith(
			database,
			build,
			{
				...SAMPLE_INVENTORY,
				cpu: { model: 'Intel(R) Core(TM) i7, 8th gen', cores: 4 },
				gpus: [
					{
						name: 'Acme "Pro" Graphics, Rev 2',
						vendor: 'Acme',
						memoryBytes: { kind: 'known', bytes: 512 * 1024 ** 2 },
						driver: ''
					}
				]
			},
			NOW + 1000
		);
		const result = exportMachines(
			database,
			admin,
			machinesQuery({ search: 'build' }),
			NOW + 2000,
			NO_RELEASES
		);
		const [row] = result.rows;
		if (row === undefined) throw new Error('no row');
		const line = csvLine(row);
		expect(line).toContain(',"Intel(R) Core(TM) i7, 8th gen",4,');
		expect(line).toContain(',"Acme ""Pro"" Graphics, Rev 2 (512 MB)",');
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
			['Early updates', 'Machines', 0, ''],
			['Test', 'Machines', 0, ''],
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
