import '../../app.css';
import { beforeEach, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { SettingKey } from '#lib/domain/settings/settings-definitions.ts';
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
	LOCAL_TLS,
	MACHINE_GROUP_ID,
	MACHINE_GROUPS,
	MACHINE,
	MACHINES,
	NOW,
	RULES,
	LONG_RECIPIENT,
	SHARE_LINK,
	USER_GROUP_ID,
	USER_GROUPS
} from '#tests/helpers/long-data.ts';
import type { CommandSelection } from '#lib/domain/commands/commands.ts';
import { COMMAND_RUN, COMMAND_RUN_SUMMARY, LONG_COMMAND } from '#tests/helpers/long-data.ts';
import CommandRunPage from './commands/[id=uuid]/+page.svelte';
import CommandsPage from './commands/+page.svelte';
import RunCommand from './commands/new/run-command.svelte';
import AccessPage from './access/+page.svelte';
import ActivityPage from './activity/+page.svelte';
import AddPage from './add/+page.svelte';
import GroupsPage from './groups/+page.svelte';
import MachinesPage from './+page.svelte';
import MorePage from './more/+page.svelte';
import DiagnosticsPage from './settings/diagnostics/+page.svelte';
import EmailPage from './settings/email/+page.svelte';
import NotificationsPage from './settings/notifications/+page.svelte';
import SettingsPage from './settings/+page.svelte';
import SignInPage from './sign-in/+page.svelte';
import UpdatesPage from './updates/+page.svelte';
import UsersPage from './users/+page.svelte';
import GuestPage from '../s/[token]/guest-page.svelte';
import {
	CONSOLE,
	checkPhoneWidth,
	IN_CONSOLE,
	stubPhoneServer,
	type PhonePage
} from './phone-overflow-harness.ts';

/**
 * SPEC-PHONE-LAYOUT U1 for the console's own pages (the machine tabs are in
 * phone-overflow-machine-tabs.svelte.test.ts); the setup is in phone-overflow-harness.ts.
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

/** Select mode's data: every machine tickable, in a group with a long name (SPEC-COMMANDS C21). */
const SELECTION: CommandSelection = {
	kind: 'allowed',
	runnable: MACHINES.map((entry) => entry.id),
	groups: [
		{ id: 'g-all', name: 'All machines', machineIds: MACHINES.map((entry) => entry.id) },
		{ id: MACHINE_GROUP_ID, name: LONG_GROUP, machineIds: MACHINES.map((entry) => entry.id) }
	]
};

function machinesPage(view: 'cards' | 'table') {
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
				view: { kind: 'machines', machines: MACHINES },
				commands: SELECTION,
				donate: { kind: 'hidden' }
			}
		},
		IN_CONSOLE
	);
}

/** Run command for every long machine; `review` goes on to Review. */
async function runCommand(review: boolean) {
	const screen = await render(
		RunCommand,
		{
			draft: {
				machineIds: MACHINES.map((entry) => entry.id),
				scripts: [
					{ osFamily: 'windows', shell: 'powershell', command: LONG_COMMAND },
					{ osFamily: 'linux', shell: 'bash', command: LONG_COMMAND }
				],
				timeoutMs: 600_000,
				rerunOf: null
			}
		},
		IN_CONSOLE
	);
	if (review) {
		await screen.getByRole('button', { name: 'Review' }).click();
	}
	return screen;
}

/** Every console page outside the machine tabs. */
const PAGES: PhonePage[] = [
	...(['cards', 'table'] as const).map((view) => ({
		name: `Machines (${view})`,
		ready: `${LONG_MACHINE_NAME}-1`,
		open: () => machinesPage(view)
	})),
	// SPEC-COMMANDS C21: select mode with its chips and bottom bar, and the Commands screens.
	...(['cards', 'table'] as const).map((view) => ({
		name: `Machines select mode (${view})`,
		ready: '1 selected',
		open: async () => {
			const screen = await machinesPage(view);
			await screen.getByRole('button', { name: 'Select', exact: true }).click();
			await screen.getByRole('button', { name: LONG_GROUP }).click();
			await screen.getByRole('checkbox', { name: `Select ${LONG_MACHINE_NAME}-1` }).click();
			return screen;
		}
	})),
	{
		name: 'Commands',
		ready: LONG_PERSON,
		open: () =>
			render(
				CommandsPage,
				{
					params: {},
					form: undefined,
					data: { ...CONSOLE, now: NOW, runs: [COMMAND_RUN_SUMMARY] }
				},
				IN_CONSOLE
			)
	},
	{ name: 'Run command', ready: 'Time limit', open: () => runCommand(false) },
	{ name: 'Run command review', ready: 'Will be skipped', open: () => runCommand(true) },
	{
		name: 'Command run results',
		ready: `${LONG_MACHINE_NAME}-2`,
		open: () =>
			render(
				CommandRunPage,
				{
					params: { id: COMMAND_RUN.id },
					form: undefined,
					data: { ...CONSOLE, now: NOW, run: COMMAND_RUN, approval: { kind: 'none' } }
				},
				IN_CONSOLE
			)
	},
	{
		name: 'Share link guest page',
		ready: SHARE_LINK.machineName,
		open: () =>
			render(GuestPage, {
				token: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
				guest: {
					machineName: SHARE_LINK.machineName,
					osFamily: 'windows',
					recipient: LONG_RECIPIENT,
					sharedByName: LONG_PERSON,
					permissions: SHARE_LINK.permissions,
					expiresIso: SHARE_LINK.expiresIso
				},
				loadedAtMs: NOW
			})
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
		ready: LONG_RECIPIENT,
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
						defaults: { permissions: ['view'], consent: 'ask' },
						now: NOW,
						activeShareLinks: [SHARE_LINK]
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
						emailReady: true,
						// The Two-factor badge beside the long name (SPEC-TWO-FACTOR 2.8).
						twoFactorOn: { [ADMIN.id]: '2026-11-10T00:00:00.000Z' }
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

function setting(key: SettingKey, value: string | boolean) {
	return { key, value, isDefault: false, updated: { kind: 'never' as const } };
}

beforeEach(stubPhoneServer);

checkPhoneWidth(PAGES);
