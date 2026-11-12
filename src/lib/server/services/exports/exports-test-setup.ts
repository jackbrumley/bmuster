import { machinesExportQuerySchema } from '#lib/schemas/exports/exports.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { listAudit } from '../audit/audit.ts';
import { updateMachineDetails } from '../machines/machine-details.ts';
import { toConsoleUser } from '../users/users.ts';
import type { CsvCell } from './csv.ts';

/**
 * The fleet and helpers the export tests share: exports.test.ts (the lists,
 * Activity and auditing) and machine-detail-export.test.ts (the Machines
 * export's Overview facts, SPEC-CSV-EXPORT X9 to X14).
 */

export const DAY = 86_400_000;

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
export async function setUp() {
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

export const DETAIL_COLUMNS = [
	'Agent update',
	'Enrolled',
	'Signed in',
	'In use',
	'Last user seen',
	'Pending updates',
	'OS build',
	'Processor',
	'Cores',
	'Memory total',
	'Graphics',
	'Disks',
	'Addresses',
	'Display',
	'Uptime',
	'Power',
	'Graphics details',
	'Network adapters'
];

export function machinesQuery(params: Record<string, string>) {
	return machinesExportQuerySchema.parse(params);
}

export function column(
	header: readonly string[],
	rows: readonly (readonly CsvCell[])[],
	name: string
) {
	const index = header.indexOf(name);
	if (index === -1) throw new Error(`no column ${name}`);
	return rows.map((row) => row[index]);
}

export function lastExportAudit(database: AppDatabase) {
	const [entry] = listAudit(database, 1);
	if (entry === undefined) throw new Error('nothing audited');
	return entry;
}
