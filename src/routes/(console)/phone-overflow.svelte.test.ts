import '../../app.css';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { PERMISSIONS, type Grant } from '#lib/domain/access/access.ts';
import type { SettingKey } from '#lib/domain/settings/settings-definitions.ts';
import { FakeEventSource } from '#tests/helpers/fake-event-source.ts';
import { FakeSocket } from '#tests/helpers/fake-socket.ts';
import {
	ADMIN,
	LONG_DESCRIPTION,
	LONG_EMAIL,
	LONG_GROUP,
	LONG_HOSTNAME,
	LONG_MACHINE_NAME,
	LONG_PERSON,
	LONG_WORD,
	DOWNLOADS,
	GROUP_NAMES,
	LINUX_MACHINE,
	LOCAL_TLS,
	longDataReply,
	MACHINE_GROUP_ID,
	MACHINE_GROUPS,
	MACHINE,
	MACHINES,
	NOW,
	pastRightEdge,
	RULES,
	USER_GROUP_ID,
	USER_GROUPS
} from '#tests/helpers/long-data.ts';
import AccessPage from './access/+page.svelte';
import ActivityPage from './activity/+page.svelte';
import AddPage from './add/+page.svelte';
import GroupsPage from './groups/+page.svelte';
import MachinesPage from './+page.svelte';
import OverviewTab from './machines/[id]/+page.svelte';
import DesktopTab from './machines/[id]/desktop/+page.svelte';
import FilesTab from './machines/[id]/files/+page.svelte';
import ManageTab from './machines/[id]/manage/+page.svelte';
import NotesTab from './machines/[id]/notes/+page.svelte';
import StorageTab from './machines/[id]/storage/+page.svelte';
import TerminalTab from './machines/[id]/terminal/+page.svelte';
import MorePage from './more/+page.svelte';
import DiagnosticsPage from './settings/diagnostics/+page.svelte';
import EmailPage from './settings/email/+page.svelte';
import NotificationsPage from './settings/notifications/+page.svelte';
import SettingsPage from './settings/+page.svelte';
import SignInPage from './sign-in/+page.svelte';
import UpdatesPage from './updates/+page.svelte';
import UsersPage from './users/+page.svelte';
import ConsoleFrame from './console-frame.svelte';

/**
 * SPEC-PHONE-LAYOUT U1: no console page scrolls sideways on a 360 px phone, with the longest names,
 * hostnames, folder names and descriptions real fleets have. Each page renders inside the real
 * console frame (and, for a machine tab, the machine layout).
 */

vi.mock('$app/navigation', () => ({ refreshAll: () => Promise.resolve(), goto: vi.fn() }));
vi.mock('$app/state', () => ({
	page: {
		url: new URL('https://bmuster.example-company.com.au/'),
		route: { id: '/(console)' },
		params: {},
		status: 200,
		error: null
	}
}));

const PHONE = { width: 360, height: 780 };

const CONSOLE = { user: ADMIN, localNetworkMode: true, serverUpdate: null, signedIn: true };
const GRANTS: Grant[] = PERMISSIONS.map((permission) => ({ permission, consent: 'unattended' }));
const MACHINE_DATA = { ...CONSOLE, now: NOW, machine: MACHINE, grants: GRANTS };
const IN_CONSOLE = {
	wrapper: ConsoleFrame,
	wrapperProps: { frame: { kind: 'console' as const, data: CONSOLE } }
};
const ON_MACHINE = {
	wrapper: ConsoleFrame,
	wrapperProps: { frame: { kind: 'machine' as const, data: MACHINE_DATA } }
};

/** Every page and tab, with the text that shows once it has its data. */
const PAGES: { name: string; ready: string; open: () => Promise<unknown> }[] = [
	...(['cards', 'table'] as const).map((view) => ({
		name: `Machines (${view})`,
		ready: `${LONG_MACHINE_NAME}-1`,
		open: () => {
			localStorage.setItem('bmuster-machines-view', view);
			return render(
				MachinesPage,
				{
					params: {},
					form: undefined,
					data: {
						...CONSOLE,
						now: NOW,
						rollout: { kind: 'none' },
						view: { kind: 'machines', machines: MACHINES }
					}
				},
				IN_CONSOLE
			);
		}
	})),
	{
		name: 'Machine overview',
		ready: LONG_HOSTNAME,
		open: () => render(OverviewTab, { params: { id: MACHINE.id }, data: MACHINE_DATA }, ON_MACHINE)
	},
	{
		name: 'Terminal',
		ready: LONG_HOSTNAME,
		open: () => render(TerminalTab, { params: { id: MACHINE.id }, data: MACHINE_DATA }, ON_MACHINE)
	},
	{
		name: 'Desktop',
		ready: LONG_HOSTNAME,
		open: () => render(DesktopTab, { params: { id: MACHINE.id }, data: MACHINE_DATA }, ON_MACHINE)
	},
	{
		name: 'Files (Windows drives)',
		ready: LONG_WORD,
		open: () => render(FilesTab, { params: { id: MACHINE.id }, data: MACHINE_DATA }, ON_MACHINE)
	},
	{
		name: 'Files (a Linux folder two levels down)',
		ready: `${LONG_WORD}.xlsx`,
		open: async () => {
			const data = { ...MACHINE_DATA, machine: LINUX_MACHINE };
			await render(
				FilesTab,
				{ params: { id: LINUX_MACHINE.id }, data },
				{ wrapper: ConsoleFrame, wrapperProps: { frame: { kind: 'machine' as const, data } } }
			);
			for (const _level of [1, 2]) {
				await page.getByText(LONG_WORD, { exact: true }).first().click();
			}
		}
	},
	{
		name: 'Storage (drives)',
		ready: `/media/${LONG_WORD}`,
		open: openStorage
	},
	{
		name: 'Storage (a folder two levels down)',
		ready: `${LONG_WORD}-cache`,
		open: async () => {
			await openStorage();
			await page.getByRole('button', { name: /^Used on / }).click();
			await page.getByRole('button', { name: new RegExp(`^${LONG_WORD}-cache`) }).click();
		}
	},
	{
		name: 'Notes',
		ready: LONG_WORD,
		open: () =>
			render(
				NotesTab,
				{
					params: { id: MACHINE.id },
					form: undefined,
					data: {
						...MACHINE_DATA,
						notes: [
							{
								id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
								authorName: LONG_PERSON,
								body: `Replaced the toner. ${LONG_WORD} ${LONG_HOSTNAME}`,
								createdIso: '2026-11-11T00:00:00.000Z',
								edited: { kind: 'yes', editedIso: '2026-11-12T00:00:00.000Z' },
								canEdit: true,
								canDelete: true
							}
						]
					}
				},
				ON_MACHINE
			)
	},
	{
		name: 'Manage',
		ready: LONG_GROUP,
		open: () =>
			render(
				ManageTab,
				{
					params: { id: MACHINE.id },
					form: undefined,
					data: {
						...MACHINE_DATA,
						downloads: DOWNLOADS,
						localTls: LOCAL_TLS,
						localPage: {
							kind: 'reported',
							address: `https://${LONG_HOSTNAME}:47100/`,
							fingerprint: 'AB:'.repeat(31) + 'AB',
							reportedIso: '2026-11-12T00:00:00.000Z'
						},
						machineGroups: MACHINE_GROUPS,
						verboseUntilIso: '2026-11-12T12:00:00.000Z',
						keepAwakeOnAc: true
					}
				},
				ON_MACHINE
			)
	},
	{
		name: 'Activity',
		ready: LONG_WORD,
		open: () =>
			render(
				ActivityPage,
				{
					params: {},
					form: undefined,
					data: {
						...CONSOLE,
						now: NOW,
						entries: [
							{
								id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
								kind: 'sign-in',
								atIso: '2026-11-12T08:00:00.000Z',
								actor: { kind: 'user', name: LONG_PERSON },
								target: `${LONG_MACHINE_NAME} ${LONG_WORD}`,
								detail: [
									{ label: 'Address', value: LONG_HOSTNAME },
									{ label: 'Browser', value: LONG_WORD }
								]
							}
						]
					}
				},
				IN_CONSOLE
			)
	},
	{
		name: 'Add machine',
		ready: 'Add a machine',
		open: () =>
			render(
				AddPage,
				{
					params: {},
					form: undefined,
					data: {
						...CONSOLE,
						machineGroups: GROUP_NAMES.user,
						downloads: DOWNLOADS,
						localTls: LOCAL_TLS
					}
				},
				IN_CONSOLE
			)
	},
	{
		name: 'Groups',
		ready: LONG_GROUP,
		open: () =>
			render(
				GroupsPage,
				{
					params: {},
					form: undefined,
					data: {
						...CONSOLE,
						userGroups: USER_GROUPS,
						machineGroups: MACHINE_GROUPS,
						rules: RULES,
						people: [{ id: ADMIN.id, label: LONG_PERSON, detail: LONG_EMAIL }],
						machines: MACHINES.map((each) => ({ id: each.id, label: each.name, detail: '' }))
					}
				},
				IN_CONSOLE
			)
	},
	{
		name: 'Access',
		ready: LONG_GROUP,
		open: () =>
			render(
				AccessPage,
				{
					params: {},
					form: undefined,
					data: {
						...CONSOLE,
						rules: RULES,
						userGroups: GROUP_NAMES.user,
						machineGroups: [{ id: MACHINE_GROUP_ID, name: LONG_GROUP }],
						defaults: { permissions: ['view'], consent: 'ask' }
					}
				},
				IN_CONSOLE
			)
	},
	{
		name: 'Users',
		ready: LONG_EMAIL,
		open: () =>
			render(
				UsersPage,
				{
					params: {},
					form: undefined,
					data: {
						...CONSOLE,
						now: NOW,
						me: ADMIN.id,
						users: [
							{
								...ADMIN,
								status: { kind: 'active' },
								hasPassword: true,
								providerNames: ['Microsoft Entra ID (Facilities and Operations tenant)'],
								lastSignIn: { kind: 'at', iso: '2026-11-12T08:00:00.000Z' },
								createdIso: '2026-11-01T00:00:00.000Z'
							}
						],
						userGroups: USER_GROUPS,
						emailReady: true
					}
				},
				IN_CONSOLE
			)
	},
	{
		name: 'Sign-in providers',
		ready: LONG_GROUP,
		open: () =>
			render(
				SignInPage,
				{
					params: {},
					form: undefined,
					data: {
						...CONSOLE,
						providers: [
							{
								id: '12121212-1212-4212-8212-121212121212',
								name: LONG_GROUP,
								kind: 'generic-oidc',
								issuer: `https://${LONG_HOSTNAME}/application/o/${LONG_WORD}/`,
								clientId: LONG_WORD,
								hasClientSecret: true,
								scopes: ['openid', 'email', 'profile', LONG_WORD],
								newPeople: 'auto-create',
								enabled: true,
								createdIso: '2026-11-01T00:00:00.000Z'
							}
						]
					}
				},
				IN_CONSOLE
			)
	},
	{
		name: 'Settings',
		ready: 'Settings',
		open: () =>
			render(
				SettingsPage,
				{
					params: {},
					form: undefined,
					data: {
						...CONSOLE,
						settings: [
							setting('organisationName', LONG_GROUP),
							setting('scamImpersonators', LONG_DESCRIPTION),
							setting('scamReportAdvice', LONG_DESCRIPTION),
							setting('defaultConsent', 'ask'),
							setting('agentUpdatePolicy', 'automatic'),
							setting('maxUploadGb', '10'),
							setting('serverUpdateChecks', true),
							setting('connectedNotice', true),
							setting('localNetworkMode', true)
						],
						localTls: LOCAL_TLS
					}
				},
				IN_CONSOLE
			)
	},
	{
		name: 'Email settings',
		ready: LONG_EMAIL,
		open: () =>
			render(
				EmailPage,
				{
					params: {},
					form: undefined,
					data: {
						...CONSOLE,
						now: NOW,
						me: { email: LONG_EMAIL },
						settings: {
							enabled: true,
							fromName: LONG_GROUP,
							fromAddress: LONG_EMAIL,
							consoleUrl: `https://${LONG_HOSTNAME}`,
							smtpHost: LONG_HOSTNAME,
							smtpPort: 587,
							smtpSecurity: 'starttls',
							smtpUsername: LONG_EMAIL,
							password: { kind: 'set' }
						},
						readiness: { kind: 'ready' },
						recent: [
							{
								id: '13131313-1313-4313-8313-131313131313',
								kind: 'notification',
								to: LONG_EMAIL,
								subject: `${LONG_MACHINE_NAME} is offline`,
								createdIso: '2026-11-12T08:00:00.000Z',
								status: {
									kind: 'failed',
									atIso: '2026-11-12T08:01:00.000Z',
									attempts: 5,
									error: `550 5.1.1 ${LONG_EMAIL}: ${LONG_WORD}`
								}
							}
						]
					}
				},
				IN_CONSOLE
			)
	},
	{
		name: 'Notifications',
		ready: MACHINE.name,
		open: () =>
			render(
				NotificationsPage,
				{
					params: {},
					form: undefined,
					data: {
						...CONSOLE,
						rules: [
							{
								id: '14141414-1414-4414-8414-141414141414',
								eventKind: 'machine-offline',
								scope: { kind: 'machine', id: MACHINE.id, name: MACHINE.name },
								recipients: { kind: 'addresses', addresses: [LONG_EMAIL, LONG_EMAIL] },
								enabled: true,
								createdIso: '2026-11-01T00:00:00.000Z'
							}
						],
						emailReady: true,
						userGroups: GROUP_NAMES.user,
						machineGroups: [{ id: MACHINE_GROUP_ID, name: LONG_GROUP }],
						machines: MACHINES.map((each) => ({ id: each.id, name: each.name }))
					}
				},
				IN_CONSOLE
			)
	},
	{
		name: 'Diagnostics tokens',
		ready: LONG_WORD,
		open: () =>
			render(
				DiagnosticsPage,
				{
					params: {},
					form: undefined,
					data: {
						...CONSOLE,
						tokens: [
							{
								id: '15151515-1515-4515-8515-151515151515',
								name: LONG_WORD,
								ownerName: LONG_PERSON,
								createdIso: '2026-11-01T00:00:00.000Z',
								expiresIso: '2026-12-01T00:00:00.000Z',
								lastUsed: { kind: 'used', atIso: '2026-11-12T08:00:00.000Z' },
								state: 'active'
							}
						]
					}
				},
				IN_CONSOLE
			)
	},
	{
		name: 'Updates',
		ready: `${LONG_MACHINE_NAME}-1`,
		open: () =>
			render(
				UpdatesPage,
				{
					params: {},
					form: undefined,
					data: {
						...CONSOLE,
						now: NOW,
						server: {
							installedVersion: '0.4.21',
							deployment: 'installed',
							checkedAtIso: '2026-11-12T08:00:00.000Z',
							lastSuccessAtIso: '2026-11-12T08:00:00.000Z',
							release: null,
							problem: `GitHub could not be reached: ${LONG_HOSTNAME} ${LONG_WORD}`,
							install: { allowed: true, reason: '' },
							operation: { phase: 'idle', from: null, to: null, message: '', atIso: null }
						},
						policy: 'automatic',
						rollout: {
							kind: 'rollout',
							version: '0.4.22',
							stage: 'early',
							startedIso: '2026-11-12T08:00:00.000Z',
							stageStartedIso: '2026-11-12T08:00:00.000Z',
							paused: { kind: 'running' }
						},
						earlyGroup: { id: MACHINE_GROUP_ID, name: 'Early updates', machines: 4 },
						testChannel: {
							group: { id: USER_GROUP_ID, name: 'Test', machines: 1 },
							build: {
								kind: 'build',
								version: '0.4.22-test.3',
								machines: MACHINES.map((each) => ({ id: each.id, name: each.name }))
							},
							check: { checkedAtIso: '2026-11-12T08:00:00.000Z', problem: LONG_DESCRIPTION }
						},
						builds: [{ version: '0.4.22-test.3', target: 'x86_64-pc-windows-msvc', signed: true }],
						machines: MACHINES.map((each) => ({
							id: each.id,
							name: each.name,
							osFamily: each.osFamily,
							agentVersion: each.agentVersion,
							status: each.status,
							update: { kind: 'rolled-back' as const, version: '0.4.22', reason: LONG_DESCRIPTION },
							channel: 'test' as const
						}))
					}
				},
				IN_CONSOLE
			)
	},
	{
		name: 'More',
		ready: 'Administration',
		open: () => render(MorePage, { params: {}, data: CONSOLE }, IN_CONSOLE)
	}
];

function openStorage() {
	return render(
		StorageTab,
		{
			params: { id: MACHINE.id },
			form: undefined,
			data: { ...MACHINE_DATA, reported: { kind: 'none' } }
		},
		ON_MACHINE
	);
}

function setting(key: SettingKey, value: string | boolean) {
	return { key, value, isDefault: false, updated: { kind: 'never' as const } };
}

beforeEach(async () => {
	await page.viewport(PHONE.width, PHONE.height);
	localStorage.clear();
	sessionStorage.clear();
	vi.stubGlobal('EventSource', FakeEventSource);
	vi.stubGlobal('WebSocket', FakeSocket);
	vi.stubGlobal(
		'fetch',
		vi.fn((input: string) => Promise.resolve(longDataReply(new URL(input, location.origin))))
	);
});

describe('phone width (SPEC-PHONE-LAYOUT U1)', () => {
	it.each(PAGES)('U1: $name does not scroll sideways at 360 px', async ({ ready, open }) => {
		await open();
		await expect.poll(() => document.body.textContent).toContain(ready);
		expect(document.documentElement.scrollWidth, pastRightEdge(PHONE.width)).toBeLessThanOrEqual(
			PHONE.width
		);
	});
});
