/**
 * PROTOTYPE ONLY. Made-up machines and activity so the console can be seen
 * and felt before the server and agent exist. Delete this folder once the
 * pages load real data; nothing outside src/routes may import it.
 */
import type {
	AccessRule,
	IdentityProvider,
	MachineGroup,
	User,
	UserGroup
} from '#lib/domain/access/access.ts';
import type { ActivityEntry } from '#lib/domain/activity/activity.ts';
import type { Machine } from '#lib/domain/machines/machine.ts';

const GB = 1024 ** 3;

function minutesAgo(now: number, minutes: number): string {
	return new Date(now - minutes * 60_000).toISOString();
}

export function prototypeMachines(now: number): Machine[] {
	return [
		{
			id: '0b6f2a52-6d3e-4c51-9a0e-6f1c2d7a8b01',
			name: 'Reception PC',
			hostname: 'RECEPTION-01',
			os: {
				family: 'windows',
				name: 'Windows 11 Pro',
				version: '24H2 (26100.4652)',
				updatesPending: 3
			},
			status: { kind: 'online', sinceIso: minutesAgo(now, 312) },
			signedInUser: { kind: 'user', name: 'sarah.k' },
			ipAddress: '192.168.1.24',
			agentVersion: '0.1.0',
			cpu: { model: 'Intel Core i5-12400', cores: 6, loadPercent: 18 },
			memory: { totalBytes: 16 * GB, usedBytes: 9.4 * GB },
			disks: [
				{ mount: 'C:', sizeBytes: 476 * GB, usedBytes: 391 * GB },
				{ mount: 'D:', sizeBytes: 931 * GB, usedBytes: 212 * GB }
			],
			displays: 2,
			tags: ['Front office']
		},
		{
			id: '1c7a3b63-7e4f-4d62-8b1f-7a2d3e8b9c02',
			name: 'Build server',
			hostname: 'build-01',
			os: { family: 'linux', name: 'Ubuntu', version: '24.04.3 LTS', updatesPending: 0 },
			status: { kind: 'online', sinceIso: minutesAgo(now, 60 * 24 * 19) },
			signedInUser: { kind: 'none' },
			ipAddress: '10.0.0.12',
			agentVersion: '0.1.0',
			cpu: { model: 'AMD Ryzen 9 7950X', cores: 16, loadPercent: 64 },
			memory: { totalBytes: 64 * GB, usedBytes: 41 * GB },
			disks: [
				{ mount: '/', sizeBytes: 1863 * GB, usedBytes: 1702 * GB },
				{ mount: '/srv', sizeBytes: 3726 * GB, usedBytes: 1210 * GB }
			],
			displays: 0,
			tags: ['Servers']
		},
		{
			id: '2d8b4c74-8f50-4e73-9c20-8b3e4f9cad03',
			name: "Jack's laptop",
			hostname: 'mint',
			os: { family: 'linux', name: 'Linux Mint', version: '22.2', updatesPending: 12 },
			status: { kind: 'online', sinceIso: minutesAgo(now, 47) },
			signedInUser: { kind: 'user', name: 'jack' },
			ipAddress: '192.168.1.50',
			agentVersion: '0.1.0',
			cpu: { model: 'Intel Core Ultra 7 155H', cores: 16, loadPercent: 9 },
			memory: { totalBytes: 32 * GB, usedBytes: 12.6 * GB },
			disks: [{ mount: '/', sizeBytes: 953 * GB, usedBytes: 388 * GB }],
			displays: 1,
			tags: ['Staff']
		},
		{
			id: '3e9c5d85-9061-4f84-ad31-9c4f50adbe04',
			name: 'Design Mac',
			hostname: 'Design-Studio.local',
			os: { family: 'macos', name: 'macOS', version: '26.1 Tahoe', updatesPending: 1 },
			status: { kind: 'offline', lastSeenIso: minutesAgo(now, 60 * 26) },
			signedInUser: { kind: 'none' },
			ipAddress: '192.168.1.31',
			agentVersion: '0.1.0',
			cpu: { model: 'Apple M3 Pro', cores: 12, loadPercent: 0 },
			memory: { totalBytes: 36 * GB, usedBytes: 0 },
			disks: [{ mount: '/', sizeBytes: 994 * GB, usedBytes: 702 * GB }],
			displays: 2,
			tags: ['Staff']
		},
		{
			id: '4fad6e96-a172-4095-be42-ad5061becf05',
			name: 'Workshop PC',
			hostname: 'WORKSHOP-02',
			os: {
				family: 'windows',
				name: 'Windows 10 Pro',
				version: '22H2 (19045.6216)',
				updatesPending: 7
			},
			status: { kind: 'offline', lastSeenIso: minutesAgo(now, 9) },
			signedInUser: { kind: 'none' },
			ipAddress: '192.168.1.77',
			agentVersion: '0.1.0',
			cpu: { model: 'Intel Core i3-8100', cores: 4, loadPercent: 0 },
			memory: { totalBytes: 8 * GB, usedBytes: 0 },
			disks: [{ mount: 'C:', sizeBytes: 238 * GB, usedBytes: 221 * GB }],
			displays: 1,
			tags: ['Workshop']
		}
	];
}

export function prototypeActivity(now: number): ActivityEntry[] {
	return [
		{
			id: 'a1',
			kind: 'terminal-opened',
			atIso: minutesAgo(now, 4),
			actor: 'jack',
			machineId: '1c7a3b63-7e4f-4d62-8b1f-7a2d3e8b9c02',
			machineName: 'Build server',
			detail: 'bash, 6 min'
		},
		{
			id: 'a2',
			kind: 'machine-offline',
			atIso: minutesAgo(now, 9),
			actor: 'system',
			machineId: '4fad6e96-a172-4095-be42-ad5061becf05',
			machineName: 'Workshop PC',
			detail: 'No check-in for 5 min'
		},
		{
			id: 'a3',
			kind: 'desktop-opened',
			atIso: minutesAgo(now, 38),
			actor: 'jack',
			machineId: '0b6f2a52-6d3e-4c51-9a0e-6f1c2d7a8b01',
			machineName: 'Reception PC',
			detail: 'Accepted by sarah.k, 12 min'
		},
		{
			id: 'a4',
			kind: 'file-sent',
			atIso: minutesAgo(now, 41),
			actor: 'jack',
			machineId: '0b6f2a52-6d3e-4c51-9a0e-6f1c2d7a8b01',
			machineName: 'Reception PC',
			detail: 'printer-driver.msi (24 MB)'
		},
		{
			id: 'a5',
			kind: 'share-link-created',
			atIso: minutesAgo(now, 60 * 5),
			actor: 'jack',
			machineId: '3e9c5d85-9061-4f84-ad31-9c4f50adbe04',
			machineName: 'Design Mac',
			detail: 'Expires after 1 hour'
		},
		{
			id: 'a6',
			kind: 'machine-enrolled',
			atIso: minutesAgo(now, 60 * 24 * 19),
			actor: 'jack',
			machineId: '1c7a3b63-7e4f-4d62-8b1f-7a2d3e8b9c02',
			machineName: 'Build server',
			detail: 'Join code K7P-4QX'
		}
	];
}

const MACHINE = {
	reception: '0b6f2a52-6d3e-4c51-9a0e-6f1c2d7a8b01',
	build: '1c7a3b63-7e4f-4d62-8b1f-7a2d3e8b9c02',
	laptop: '2d8b4c74-8f50-4e73-9c20-8b3e4f9cad03',
	mac: '3e9c5d85-9061-4f84-ad31-9c4f50adbe04',
	workshop: '4fad6e96-a172-4095-be42-ad5061becf05'
};

export function prototypeUserGroups(): UserGroup[] {
	return [
		{ id: 'ug-helpdesk', name: 'Helpdesk', description: 'First-line support for staff machines' },
		{ id: 'ug-engineers', name: 'Engineers', description: 'Run and fix the servers' },
		{ id: 'ug-office', name: 'Office managers', description: 'Watch front-office screens' }
	];
}

export function prototypeMachineGroups(): MachineGroup[] {
	return [
		{
			id: 'mg-staff',
			name: 'Staff computers',
			description: 'Desktops and laptops people use',
			machineIds: [MACHINE.reception, MACHINE.laptop, MACHINE.mac, MACHINE.workshop]
		},
		{
			id: 'mg-servers',
			name: 'Servers',
			description: 'Headless Linux servers',
			machineIds: [MACHINE.build]
		},
		{
			id: 'mg-front',
			name: 'Front office',
			description: 'Reception and the workshop floor',
			machineIds: [MACHINE.reception, MACHINE.workshop]
		}
	];
}

export function prototypeAccessRules(): AccessRule[] {
	return [
		{
			id: 'r1',
			userGroupId: 'ug-helpdesk',
			machineGroupId: 'mg-staff',
			permissions: ['view', 'desktop-view', 'desktop-control', 'files'],
			consent: 'ask'
		},
		{
			id: 'r2',
			userGroupId: 'ug-engineers',
			machineGroupId: 'mg-servers',
			permissions: ['view', 'terminal', 'files'],
			consent: 'unattended'
		},
		{
			id: 'r3',
			userGroupId: 'ug-engineers',
			machineGroupId: 'mg-staff',
			permissions: ['view', 'terminal', 'desktop-view', 'desktop-control', 'files', 'share-links'],
			consent: 'ask'
		},
		{
			id: 'r4',
			userGroupId: 'ug-office',
			machineGroupId: 'mg-front',
			permissions: ['view', 'desktop-view'],
			consent: 'ask'
		}
	];
}

export function prototypeUsers(now: number): User[] {
	return [
		{
			id: 'u1',
			name: 'Jack Brumley',
			email: 'jack@example.com',
			role: 'admin',
			signIn: { kind: 'password' },
			userGroupIds: ['ug-engineers'],
			lastSignInIso: minutesAgo(now, 3)
		},
		{
			id: 'u2',
			name: 'Priya Natarajan',
			email: 'priya@example.com',
			role: 'member',
			signIn: { kind: 'provider', providerName: 'Microsoft 365' },
			userGroupIds: ['ug-helpdesk'],
			lastSignInIso: minutesAgo(now, 60 * 3)
		},
		{
			id: 'u3',
			name: 'Tom Walsh',
			email: 'tom@example.com',
			role: 'member',
			signIn: { kind: 'provider', providerName: 'Microsoft 365' },
			userGroupIds: ['ug-helpdesk', 'ug-office'],
			lastSignInIso: minutesAgo(now, 60 * 30)
		},
		{
			id: 'u4',
			name: 'Sam Lee',
			email: 'sam@example.com',
			role: 'member',
			signIn: { kind: 'provider', providerName: 'Authentik' },
			userGroupIds: ['ug-engineers'],
			lastSignInIso: minutesAgo(now, 60 * 24 * 4)
		}
	];
}

export function prototypeIdentityProviders(): IdentityProvider[] {
	return [
		{ id: 'idp-m365', name: 'Microsoft 365', kind: 'microsoft-entra', enabled: true },
		{ id: 'idp-authentik', name: 'Authentik', kind: 'authentik', enabled: true }
	];
}
