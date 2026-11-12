/**
 * Realistic worst-case text for layout tests: the long names, hostnames, folder names and
 * descriptions real fleets have, many with no place to break a line. A track or row that grows
 * to fit them pushes a phone page sideways (SPEC-PHONE-LAYOUT U1).
 */
import { PERMISSIONS } from '#lib/domain/access/access.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { Machine, MachineInventory } from '#lib/domain/machines/machine.ts';
import type { SessionInUse } from '#lib/domain/sessions/session.ts';

const GB = 1024 ** 3;

export const NOW = Date.parse('2026-11-12T09:00:00.000Z');

export const LONG_MACHINE_NAME = 'Reception-Front-Desk-Workstation-Ground-Floor-Building-B-0001';
export const LONG_HOSTNAME =
	'reception-front-desk-workstation-01.branch-office.internal.example-company.com.au';
export const LONG_PERSON = 'Maximiliana Featherstonehaugh-Cholmondeley-Worthington';
export const LONG_EMAIL =
	'maximiliana.featherstonehaugh-cholmondeley@facilities-and-operations.example-company.com.au';
export const LONG_WORD = 'Quarterly_Financial_Reports_And_Supporting_Documentation_2026_Final_v12';
export const LONG_DESCRIPTION = `Front desk machine shared by the morning and afternoon reception teams; asset tag ${LONG_WORD}, see ${LONG_HOSTNAME} for the printer queue.`;
export const LONG_GROUP = 'Facilities-And-Operations-Regional-Branch-Offices-Victoria-West';

export const ADMIN: ConsoleUser = {
	id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
	name: LONG_PERSON,
	email: LONG_EMAIL,
	role: 'admin'
};

const IN_USE: SessionInUse[] = [
	{ kind: 'desktop', mode: 'control', userName: LONG_PERSON },
	{ kind: 'terminal', userName: 'Bartholomew Montgomery-Fitzwilliam' },
	{ kind: 'files', userName: LONG_EMAIL }
];

const INVENTORY: MachineInventory = {
	kind: 'known',
	osName: 'Microsoft Windows 11 Enterprise LTSC Multi-Session Evaluation Edition',
	osVersion: '24H2',
	osBuild: '10.0.26100.2314.amd64fre.ge_release_svc_prod3.241025-1543',
	updates: { kind: 'known', count: 14 },
	cpuModel: '13th Gen Intel(R) Core(TM) i9-13900HX with Integrated Performance Telemetry',
	cpuCores: 32,
	memoryTotalBytes: 64 * 1024 ** 3,
	disks: [
		{ mount: 'C:\\', sizeBytes: 1024 ** 4, usedBytes: 0.95 * 1024 ** 4 },
		{ mount: `D:\\${LONG_WORD}`, sizeBytes: 2 * 1024 ** 4, usedBytes: 1024 ** 4 }
	],
	network: [
		{
			name: 'Intel(R) Ethernet Connection (17) I219-LM #2 - Virtual Switch Extension',
			mac: '00:11:22:33:44:55',
			addresses: ['10.20.30.40', 'fe80::1c2d:3e4f:5a6b:7c8d%eth0-long-scope-identifier']
		}
	],
	gpus: [
		{
			name: 'NVIDIA GeForce RTX 4090 Laptop GPU with Max-Q Technologies Enabled',
			vendor: 'NVIDIA Corporation',
			memoryBytes: { kind: 'known', bytes: 16 * 1024 ** 3 },
			driver: 'nvidia 560.94.0000.0000-dch-studio-driver-long-build-label'
		}
	],
	display: { kind: 'unreported' },
	power: {
		kind: 'reported',
		source: 'mains',
		batteryPercent: 98,
		keepAwake: 'active',
		inhibitor: { kind: 'none' }
	}
};

function machine(number: number): Machine {
	const suffix = String(number).padStart(12, '0');
	return {
		id: `11111111-1111-4111-8111-${suffix}`,
		name: `${LONG_MACHINE_NAME}-${String(number)}`,
		description: LONG_DESCRIPTION,
		hostname: LONG_HOSTNAME,
		osFamily: number % 2 === 0 ? 'windows' : 'linux',
		target: 'x86_64-pc-windows-msvc',
		agentVersion: '0.4.21-test.12',
		update: { kind: 'available', version: '0.4.22', needsReinstall: false },
		status:
			number % 3 === 0
				? { kind: 'offline', sinceIso: '2026-11-10T09:00:00.000Z' }
				: { kind: 'online' },
		lastUser: { kind: 'user', name: LONG_EMAIL, seenIso: '2026-11-12T08:00:00.000Z' },
		live: {
			kind: 'known',
			cpuPercent: 87,
			memoryUsedBytes: 60 * 1024 ** 3,
			uptimeSeconds: 40 * 86_400,
			signedInUser: { kind: 'user', name: LONG_EMAIL }
		},
		inventory: INVENTORY,
		enrolledIso: '2026-11-01T00:00:00.000Z',
		lastSeenIso: '2026-11-12T08:59:00.000Z',
		inUse: IN_USE,
		lowDisk: [
			{ mount: 'C:\\', percent: 95, freeBytes: 51 * 1024 ** 3 },
			{ mount: `D:\\${LONG_WORD}`, percent: 91, freeBytes: 9 * 1024 ** 3 }
		]
	};
}

export const MACHINES: Machine[] = [1, 2, 3, 4].map(machine);
/** A Windows machine, online. */
export const MACHINE: Machine = machine(2);
/** A Linux machine, online. */
export const LINUX_MACHINE: Machine = machine(1);

export const USER_GROUP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const MACHINE_GROUP_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const USER_GROUPS = [
	{ id: USER_GROUP_ID, name: LONG_GROUP, description: LONG_DESCRIPTION, memberIds: [ADMIN.id] }
];
export const GROUP_NAMES = { user: [{ id: USER_GROUP_ID, name: LONG_GROUP }] };
export const MACHINE_GROUPS = [
	{
		id: MACHINE_GROUP_ID,
		name: LONG_GROUP,
		description: LONG_DESCRIPTION,
		builtIn: 'none' as const,
		membership: { kind: 'chosen' as const, machineIds: MACHINES.map((each) => each.id) }
	}
];
export const RULES = [
	{
		id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
		userGroupId: USER_GROUP_ID,
		machineGroupId: MACHINE_GROUP_ID,
		permissions: [...PERMISSIONS],
		consent: 'ask' as const,
		createdIso: '2026-11-01T00:00:00.000Z'
	}
];
export const DOWNLOADS = [
	{
		kind: 'ready' as const,
		target: 'x86_64-unknown-linux-gnu' as const,
		version: '0.4.21',
		size: 9 * 1024 ** 2,
		sha256: 'f'.repeat(64)
	}
];
export const LOCAL_TLS = {
	on: true,
	restartNeeded: false,
	served: {
		kind: 'pin' as const,
		pin: `sha256:${'A'.repeat(43)}=`,
		fingerprint: 'ab'.repeat(32)
	}
};

/** A `fetch` reply with the long folder and file names the Files and Storage tabs list. */
export function longDataReply(url: URL): Response {
	const json = (body: unknown, status = 200) => Response.json(body, { status });
	if (url.pathname.endsWith('/files/roots')) {
		return json({
			roots: [
				{ path: '/', label: LONG_WORD, kind: 'drive', totalBytes: 500 * GB, freeBytes: GB },
				{
					path: `/media/${LONG_WORD}`,
					label: LONG_WORD,
					kind: 'drive',
					totalBytes: null,
					freeBytes: null
				}
			]
		});
	}
	if (url.pathname.endsWith('/files/list')) {
		const entry = (name: string, kind: 'folder' | 'file' | 'link') => ({
			name,
			kind,
			size: 123 * GB,
			modifiedMs: NOW,
			hidden: false,
			linkTarget: kind === 'link' ? `/srv/${LONG_WORD}/${LONG_WORD}` : null
		});
		return json({
			path: url.searchParams.get('path') ?? '/',
			entries: [
				entry(LONG_WORD, 'folder'),
				entry(`${LONG_WORD}.xlsx`, 'file'),
				entry(`${LONG_WORD}-link`, 'link')
			],
			more: true
		});
	}
	if (url.pathname.endsWith('/storage/summary')) {
		return json({
			drives: [
				{
					mount: `/media/${LONG_WORD}`,
					sizeBytes: 100 * GB,
					freeBytes: 4 * GB,
					lastScan: {
						kind: 'complete',
						startedAtMs: NOW - 7_200_000,
						finishedAtMs: NOW - 3_600_000,
						scannedBytes: 90 * GB,
						usedBytes: 96 * GB,
						files: 1_234_567,
						folders: 123_456,
						denied: 42
					},
					scanning: { kind: 'idle' }
				}
			],
			problem: { kind: 'none' }
		});
	}
	if (url.pathname.endsWith('/storage/folder')) {
		const path = url.searchParams.get('path') ?? '/';
		return json({
			mount: `/media/${LONG_WORD}`,
			path,
			finishedAtMs: NOW - 3_600_000,
			bytes: 90 * GB,
			files: 1000,
			ownBytes: GB,
			ownFiles: 12,
			foldedFolders: 30,
			foldedBytes: 2 * GB,
			notScannedBytes: 6 * GB,
			children: [
				{
					name: `${LONG_WORD}-cache`,
					path: `${path}/${LONG_WORD}-cache`,
					bytes: 60 * GB,
					files: 800,
					hasChildren: true
				}
			],
			offset: 0,
			more: true
		});
	}
	if (url.pathname.endsWith('/storage/largest')) {
		return json({
			files: [
				{
					path: `/media/${LONG_WORD}/${LONG_WORD}/${LONG_WORD}.iso`,
					bytes: 50 * GB,
					modifiedMs: NOW
				}
			]
		});
	}
	if (url.pathname.endsWith('/storage/cleanup')) {
		return json({ run: { kind: 'none' } });
	}
	return json({ message: `Not in this test: ${url.pathname}` }, 404);
}

/**
 * The elements that reach past the right edge, to say what to fix. Content inside a scroller (a
 * tab row that scrolls) is left out: the scroller keeps it within the page.
 */
export function pastRightEdge(width: number): string {
	const clipped = (element: Element): boolean => {
		for (let parent = element.parentElement; parent !== null; parent = parent.parentElement) {
			if (getComputedStyle(parent).overflowX !== 'visible') {
				return true;
			}
		}
		return false;
	};
	return [...document.body.querySelectorAll('*')]
		.filter((element) => element.getBoundingClientRect().right > width + 0.5)
		.filter((element) => !clipped(element))
		.map((element) => {
			const name = [element.tagName.toLowerCase(), ...element.classList].join('.');
			return `${name} (right edge ${String(Math.round(element.getBoundingClientRect().right))})`;
		})
		.slice(0, 15)
		.join('\n');
}
