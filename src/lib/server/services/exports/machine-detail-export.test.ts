import { describe, expect, it } from 'vitest';
import type { InventoryWire } from '#lib/schemas/agents/agent-protocol.ts';
import { NO_RELEASES, SAMPLE_INVENTORY } from '#tests/helpers/fake-agent.ts';
import { NOW } from '#tests/helpers/people.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { recordCheckIn } from '../agents/check-in.ts';
import { socketClosed, socketOpened } from '../agents/presence.ts';
import { csvLine } from './csv.ts';
import { exportMachines } from './exports.ts';
import { DAY, DETAIL_COLUMNS, machinesQuery, setUp } from './exports-test-setup.ts';
/**
 * The Machines export's full detail (SPEC-CSV-EXPORT X9 to X14): every fact
 * of the machine's Overview, as on screen. The lists, Activity and auditing
 * are in exports.test.ts.
 */

/** A check-in from the machine with this inventory, with sarah.k signed in, up for a minute. */
function checkInWith(database: AppDatabase, machineId: string, data: InventoryWire, at: number) {
	checkInUpFor(database, machineId, data, at, 60);
}

function checkInUpFor(
	database: AppDatabase,
	machineId: string,
	data: InventoryWire,
	at: number,
	uptimeSeconds: number
) {
	recordCheckIn(
		database,
		{ machineId, checkInSeconds: 60 },
		{
			agentVersion: '0.1.0',
			uptimeSeconds,
			update: { kind: 'no-launcher' },
			signedInUser: { kind: 'user', name: 'sarah.k' },
			load: { cpuPercent: 5, memoryUsedBytes: 1024 },
			inventory: { kind: 'full', hash: 'b'.repeat(64), data },
			localUsers: { kind: 'unsupported' },
			checks: { kind: 'unreported' },
			storage: { kind: 'unreported' }
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
	],
	power: {
		kind: 'reported',
		source: 'mains',
		batteryPercent: 80,
		keepAwake: 'active',
		inhibitor: { kind: 'held' }
	}
};

describe('Machines export (X5, X6)', () => {
	it('X9: header order: the first columns stay put, then every Overview fact', async () => {
		const { database, admin, pat } = await setUp();
		const all = exportMachines(database, admin, machinesQuery({}), NOW, NO_RELEASES);
		expect(all.header.slice(0, 11)).toEqual([
			'Name',
			'Host',
			'Status',
			'OS',
			'OS version',
			'Disk % (fullest)',
			'Last user',
			'Last seen',
			'Groups',
			'Agent version',
			'Description'
		]);
		expect(all.header.slice(11)).toEqual(DETAIL_COLUMNS);
		// X12: a member gets the same detail columns (they see the same Overview), only no Groups.
		const mine = exportMachines(database, pat, machinesQuery({}), NOW, NO_RELEASES);
		expect(mine.header).toEqual(all.header.filter((name) => name !== 'Groups'));
		expect(all.rows.map((row) => row.length)).toEqual([29, 29, 29]);
		expect(mine.rows.map((row) => row.length)).toEqual([28, 28]);
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
		expect(offline['Uptime']).toBeNull();
		expect(offline['Processor']).toBe('Test CPU');
	});

	it('SPEC-PRESENCE P9: a machine whose socket just closed exports as Reconnecting', async () => {
		const { database, admin, reception } = await setUp();
		socketOpened(database, reception, NOW);
		socketClosed(database, reception, NOW);
		const result = exportMachines(database, admin, machinesQuery({}), NOW + 1000, NO_RELEASES);
		const row = result.rows.find((cells) => cells[0] === 'Reception PC');
		expect(row?.[result.header.indexOf('Status')]).toBe('Reconnecting');
	});

	it('X13: uptime, power, graphics vendor and driver, and each adapter, as on the Overview', async () => {
		const { database, admin, reception } = await setUp();
		// Up 3 days 4 h 59 min at the check-in; exported 90 s later, still online: 3 days 5 h.
		checkInUpFor(database, reception, FULL_INVENTORY, NOW + 1000, 3 * 86_400 + 4 * 3600 + 59 * 60);
		const result = exportMachines(
			database,
			admin,
			machinesQuery({ search: 'reception' }),
			NOW + 1000 + 90_000,
			NO_RELEASES
		);
		const [row] = result.rows;
		if (row === undefined) throw new Error('no row');
		const detail = Object.fromEntries(result.header.map((name, index) => [name, row[index]]));
		expect(detail).toMatchObject({
			Status: 'Online',
			Uptime: '3 days 5 h',
			Power: 'Mains, battery 80%',
			'Graphics details':
				'NVIDIA GeForce RTX 4070 (12 GB): NVIDIA Corporation · driver nvidia 550.54; ' +
				'Intel UHD Graphics 770: Intel Corporation · driver i915',
			'Network adapters':
				'eth0: MAC 00:11:22:33:44:55 · 10.0.0.5, fe80::1; wlan0: MAC 66:77:88:99:aa:bb · 192.168.1.20'
		});
		// The keep-awake state is Manage's (admins only); it never reaches the file.
		expect(csvLine(row)).not.toMatch(/awake|held/i);
	});

	it('X14: uptime is empty while offline; inventory facts stay as last reported', async () => {
		const { database, admin, laptop } = await setUp();
		checkInWith(database, laptop, FULL_INVENTORY, NOW - DAY);
		const result = exportMachines(
			database,
			admin,
			machinesQuery({ search: 'laptop' }),
			NOW,
			NO_RELEASES
		);
		const [row] = result.rows;
		if (row === undefined) throw new Error('no row');
		const detail = Object.fromEntries(result.header.map((name, index) => [name, row[index]]));
		expect(detail).toMatchObject({
			Status: 'Offline',
			Uptime: null,
			Power: 'Mains, battery 80%'
		});
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
});
