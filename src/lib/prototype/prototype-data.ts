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

function minutesAgo(now: number, minutes: number): string {
	return new Date(now - minutes * 60_000).toISOString();
}

/** Names for the prototype machine groups; real machines come from the database. */
export function prototypeMachines(): { id: string; name: string }[] {
	return [
		{ id: '0b6f2a52-6d3e-4c51-9a0e-6f1c2d7a8b01', name: 'Reception PC' },
		{ id: '1c7a3b63-7e4f-4d62-8b1f-7a2d3e8b9c02', name: 'Build server' },
		{ id: '2d8b4c74-8f50-4e73-9c20-8b3e4f9cad03', name: "Jack's laptop" },
		{ id: '3e9c5d85-9061-4f84-ad31-9c4f50adbe04', name: 'Design Mac' },
		{ id: '4fad6e96-a172-4095-be42-ad5061becf05', name: 'Workshop PC' }
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
