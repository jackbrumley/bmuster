import '../../app.css';
import { afterEach, beforeEach, describe, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { SavedCommandEntry, SavedCommandView } from '#lib/domain/commands/saved-commands.ts';
import {
	LONG_COMMAND,
	LONG_DESCRIPTION,
	LONG_GROUP,
	LONG_HOSTNAME,
	LONG_MACHINE_NAME,
	LONG_WORD,
	longDataReply,
	MACHINE_GROUP_ID,
	NOW
} from '#tests/helpers/long-data.ts';
import SavedCommandChoice from './commands/new/saved-command-choice.svelte';
import SavedListPage from './commands/saved/+page.svelte';
import SavedEditPage from './commands/saved/[id=uuid]/+page.svelte';
import SavedRunPage from './commands/saved/[id=uuid]/run/+page.svelte';
import AiAssistantsPage from './settings/ai-assistants/+page.svelte';
import {
	CONSOLE,
	checkPhoneWidth,
	IN_CONSOLE,
	stubPhoneServer,
	type PhonePage
} from './phone-overflow-harness.ts';

/**
 * SPEC-SAVED-COMMANDS SC26 (SPEC-PHONE-LAYOUT U1): saved commands work on a 360 px phone with the
 * longest names: the list, the form with every kind of parameter, the run screen and its Review,
 * Run command's saved command choice, and Settings → AI assistants with what AI can reach.
 */

const SAVED_ID = '19191919-1919-4919-8919-191919191919';
const MACHINE_ID = '20202020-2020-4020-8020-202020202020';

const page = vi.hoisted(() => {
	const shown: {
		url: URL;
		route: { id: string };
		params: Record<string, string>;
		status: number;
		error: null;
		state: Record<string, unknown>;
	} = {
		url: new URL('https://bmuster.example.com/commands/saved'),
		route: { id: '/(console)/commands/saved' },
		params: {},
		status: 200,
		error: null,
		state: {}
	};
	return shown;
});

vi.mock('$app/navigation', () => ({
	refreshAll: () => Promise.resolve(),
	goto: vi.fn()
}));
vi.mock('$app/state', () => ({ page }));

const COMMAND: SavedCommandView = {
	id: SAVED_ID,
	name: LONG_MACHINE_NAME,
	description: LONG_DESCRIPTION,
	effect: 'changes',
	systems: ['windows', 'linux'],
	enabled: true,
	aiUnattended: true,
	version: 12,
	scripts: [
		{ osFamily: 'windows', shell: 'powershell', script: LONG_COMMAND },
		{ osFamily: 'linux', shell: 'bash', script: `systemctl status "$BMUSTER_PARAM_${LONG_WORD}"` }
	],
	parameters: [
		{ kind: 'text', name: 'service', label: LONG_WORD, pattern: 'path' },
		{ kind: 'number', name: 'hours', label: LONG_GROUP, min: -1_000_000_000, max: 1_000_000_000 },
		{ kind: 'choice', name: 'unit', label: 'Unit', choices: [LONG_WORD, LONG_GROUP] }
	],
	machineGroupIds: [MACHINE_GROUP_ID],
	timeoutMs: 600_000
};

const ENTRY: SavedCommandEntry = {
	id: SAVED_ID,
	name: LONG_MACHINE_NAME,
	description: LONG_DESCRIPTION,
	effect: 'changes',
	systems: ['windows', 'linux'],
	enabled: false,
	aiUnattended: true,
	version: 12,
	machineIds: [MACHINE_ID]
};

const GROUPS = [
	{ id: MACHINE_GROUP_ID, name: LONG_GROUP },
	{ id: '21212121-2121-4121-8121-212121212121', name: LONG_HOSTNAME }
];

/** The saved command routes answer with long data; everything else as the harness does. */
function stubSavedServer(): void {
	vi.stubGlobal(
		'fetch',
		vi.fn((input: string) => {
			const url = new URL(input, location.origin);
			if (url.pathname.endsWith('/plan')) {
				return Promise.resolve(
					Response.json({
						commands: [
							{
								osFamily: 'windows',
								shell: 'powershell',
								command: `# BMuster: saved command parameters\n$env:BMUSTER_PARAM_SERVICE = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${btoa(LONG_WORD)}'))\n\n${LONG_COMMAND}`
							}
						],
						machines: [
							{
								id: MACHINE_ID,
								name: LONG_MACHINE_NAME,
								osFamily: 'windows',
								plan: { kind: 'runs' }
							},
							{
								id: '22222222-2222-4222-8222-222222222222',
								name: LONG_HOSTNAME,
								osFamily: 'windows',
								plan: { kind: 'skipped', reason: 'agent-too-old' }
							}
						],
						signIn: { kind: 'password' }
					})
				);
			}
			if (url.pathname.endsWith('/api/commands/saved')) {
				return Promise.resolve(Response.json({ commands: [{ ...ENTRY, enabled: true }] }));
			}
			return Promise.resolve(longDataReply(url));
		})
	);
}

const runData = {
	...CONSOLE,
	command: {
		id: COMMAND.id,
		name: COMMAND.name,
		description: COMMAND.description,
		effect: COMMAND.effect,
		version: COMMAND.version,
		parameters: COMMAND.parameters,
		timeoutMs: COMMAND.timeoutMs
	},
	machines: [
		{ id: MACHINE_ID, name: LONG_MACHINE_NAME, osFamily: 'windows' as const },
		{ id: '23232323-2323-4323-8323-232323232323', name: LONG_HOSTNAME, osFamily: 'linux' as const }
	]
};

const PAGES: readonly PhonePage[] = [
	{
		name: 'SC26: Saved commands',
		ready: 'AI runs it without approval',
		open: () =>
			render(
				SavedListPage,
				{ params: {}, form: undefined, data: { ...CONSOLE, commands: [ENTRY], canWrite: true } },
				IN_CONSOLE
			)
	},
	{
		name: 'SC26: a saved command’s form',
		ready: 'Remove parameter',
		open: () =>
			render(
				SavedEditPage,
				{
					params: { id: SAVED_ID },
					form: undefined,
					data: { ...CONSOLE, command: COMMAND, groups: GROUPS, signIn: { kind: 'password' } }
				},
				IN_CONSOLE
			)
	},
	{
		name: 'SC26: running a saved command',
		ready: 'Select all 2',
		open: () =>
			render(SavedRunPage, { params: { id: SAVED_ID }, form: undefined, data: runData }, IN_CONSOLE)
	},
	{
		name: 'SC26: a saved command’s Review',
		ready: 'Will be skipped',
		open: async () => {
			page.state = { savedRunDraft: { machineIds: [MACHINE_ID] } };
			const screen = await render(
				SavedRunPage,
				{ params: { id: SAVED_ID }, form: undefined, data: runData },
				IN_CONSOLE
			);
			await screen.getByRole('textbox', { name: new RegExp(LONG_WORD) }).fill('C:\\Data');
			await screen.getByRole('textbox', { name: new RegExp(LONG_GROUP) }).fill('7');
			await screen.getByRole('button', { name: 'Review' }).click();
			page.state = {};
		}
	},
	{
		name: 'SC26: Run command’s saved command choice',
		ready: 'runs on 1 of 1 selected',
		open: () => render(SavedCommandChoice, { machineIds: [MACHINE_ID] }, IN_CONSOLE)
	},
	{
		name: 'SC26: Settings → AI assistants, with what AI can reach',
		ready: '…and ask to run commands on all machines',
		open: () =>
			render(
				AiAssistantsPage,
				{
					params: {},
					form: undefined,
					data: {
						...CONSOLE,
						now: NOW,
						settings: {
							enabled: true,
							userGroup: { kind: 'group', id: MACHINE_GROUP_ID, name: LONG_GROUP }
						},
						groups: [{ id: MACHINE_GROUP_ID, name: LONG_GROUP }],
						approvers: { mode: 'requester', group: { kind: 'none' } },
						aiAccess: {
							kind: 'group',
							canView: 123456,
							canAsk: 7890,
							viewsAll: false,
							asksAll: false
						},
						unattended: true,
						grants: [],
						serverUrl: `https://${LONG_HOSTNAME}/mcp`
					}
				},
				IN_CONSOLE
			)
	}
];

beforeEach(async () => {
	await stubPhoneServer();
	stubSavedServer();
});

checkPhoneWidth(PAGES);

describe('in the dark theme', () => {
	beforeEach(() => {
		document.documentElement.dataset['theme'] = 'dark';
	});
	afterEach(() => {
		delete document.documentElement.dataset['theme'];
	});
	checkPhoneWidth(PAGES);
});
