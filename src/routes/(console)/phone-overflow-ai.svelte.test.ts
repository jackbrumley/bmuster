import '../../app.css';
import { afterEach, beforeEach, describe, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { GrantView } from '#lib/domain/mcp/mcp.ts';
import {
	LONG_COMMAND,
	LONG_GROUP,
	LONG_HOSTNAME,
	LONG_MACHINE_NAME,
	LONG_PERSON,
	LONG_WORD,
	MACHINE_GROUP_ID,
	NOW,
	USER_GROUP_ID
} from '#tests/helpers/long-data.ts';
import ConsentPage from '../oauth/authorize/+page.svelte';
import AccountPage from './account/+page.svelte';
import ApprovalsPage from './approvals/+page.svelte';
import RunPage from './commands/[id=uuid]/+page.svelte';
import ConsoleFrame from './console-frame.svelte';
import AiAssistantsPage from './settings/ai-assistants/+page.svelte';
import {
	CONSOLE,
	checkPhoneWidth,
	IN_CONSOLE,
	stubPhoneServer,
	type PhonePage
} from './phone-overflow-harness.ts';

/**
 * SPEC-MCP M16 and M30 (SPEC-PHONE-LAYOUT U1): AI assistants work on a 360 px phone with the
 * longest names: the consent screen, the Account page, Settings → AI assistants, the Approvals
 * page and the approval card (with Approvals and its count in the tab bar). Kept apart from
 * phone-overflow.svelte.test.ts, which is at its size limit; the setup is the same harness.
 */

vi.mock('$app/navigation', () => ({
	refreshAll: () => Promise.resolve(),
	goto: vi.fn()
}));
vi.mock('$app/state', () => ({
	page: {
		url: new URL('https://bmuster.example-company.com.au/settings/ai-assistants'),
		route: { id: '/(console)/settings/ai-assistants' },
		params: {},
		status: 200,
		error: null
	}
}));

const RUN_ID = '18181818-1818-4818-8818-181818181818';

/** Someone who may approve, with many requests waiting: Approvals and its count in the tab bar. */
const APPROVER = { ...CONSOLE, approvals: { kind: 'shown' as const, pending: 12 } };
const AS_APPROVER = {
	wrapper: ConsoleFrame,
	wrapperProps: { frame: { kind: 'console' as const, data: APPROVER } }
};

/** Connected assistants with the longest names and addresses. */
const GRANTS: GrantView[] = [
	{
		id: '16161616-1616-4616-8616-161616161616',
		assistant: { name: LONG_MACHINE_NAME, identity: { kind: 'verified', host: LONG_HOSTNAME } },
		userName: LONG_PERSON,
		createdIso: '2026-11-01T00:00:00.000Z',
		lastUsed: {
			kind: 'used',
			atIso: '2026-11-12T08:00:00.000Z',
			ip: '2001:db8:ffff:ffff:ffff:ffff:ffff:ffff'
		},
		active: true
	},
	{
		id: '17171717-1717-4717-8717-171717171717',
		assistant: { name: LONG_WORD, identity: { kind: 'unverified' } },
		userName: LONG_PERSON,
		createdIso: '2026-11-01T00:00:00.000Z',
		lastUsed: { kind: 'never' },
		active: false
	}
];

const PAGES: readonly PhonePage[] = [
	// SPEC-MCP M16: connecting an AI assistant, on a phone.
	{
		name: 'M16: AI assistant consent screen',
		ready: 'wants to act as you',
		open: () =>
			render(ConsentPage, {
				params: {},
				form: null,
				data: {
					signedIn: true,
					userName: LONG_PERSON,
					fields: [{ name: 'client_id', value: LONG_WORD }],
					view: {
						kind: 'ask',
						assistant: {
							name: LONG_MACHINE_NAME,
							identity: { kind: 'verified', host: LONG_HOSTNAME }
						},
						redirect: { kind: 'web', host: LONG_HOSTNAME },
						scopes: ['machines:read', 'offline_access']
					}
				}
			})
	},
	{
		name: 'M16: Account',
		ready: 'Connected AI assistants',
		open: () =>
			render(
				AccountPage,
				{
					params: {},
					form: undefined,
					data: {
						...CONSOLE,
						now: NOW,
						signIn: ['Password', LONG_GROUP],
						connect: 'on',
						serverUrl: `https://${LONG_HOSTNAME}/mcp`,
						grants: GRANTS,
						origin: `https://${LONG_HOSTNAME}`,
						// SPEC-TWO-FACTOR: the panel with its warning and both buttons, at phone width.
						twoFactor: {
							kind: 'on',
							sinceIso: new Date(NOW - 86_400_000).toISOString(),
							recoveryCodesLeft: 2,
							required: false
						}
					}
				},
				IN_CONSOLE
			)
	},
	{
		name: 'M16: Settings → AI assistants',
		ready: 'Stop all AI access',
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
							userGroup: { kind: 'group', id: USER_GROUP_ID, name: LONG_GROUP }
						},
						groups: [
							{ id: USER_GROUP_ID, name: LONG_GROUP },
							{ id: MACHINE_GROUP_ID, name: LONG_WORD }
						],
						approvers: {
							mode: 'requester-or-group',
							group: { kind: 'group', id: USER_GROUP_ID, name: LONG_GROUP }
						},
						grants: GRANTS,
						serverUrl: `https://${LONG_HOSTNAME}/mcp`
					}
				},
				IN_CONSOLE
			)
	},
	// SPEC-MCP M30: approving an AI assistant's command, on a phone.
	{
		name: 'M30: Approvals',
		ready: 'Nothing runs until a person approves it',
		open: () =>
			render(
				ApprovalsPage,
				{
					params: {},
					form: undefined,
					data: {
						...APPROVER,
						now: NOW,
						requests: [
							{
								runId: RUN_ID,
								requestedBy: LONG_PERSON,
								assistant: `unverified client ${LONG_WORD}`,
								machineNames: [LONG_MACHINE_NAME, LONG_WORD, LONG_HOSTNAME],
								firstLine: LONG_COMMAND.split('\n')[0] ?? '',
								requestedIso: new Date(NOW - 60_000).toISOString(),
								expiresIso: new Date(NOW + 9 * 60_000).toISOString()
							}
						]
					}
				},
				AS_APPROVER
			)
	},
	{
		name: 'M30: approval card',
		ready: 'says:',
		open: () =>
			render(
				RunPage,
				{
					params: { id: RUN_ID },
					form: undefined,
					data: {
						...APPROVER,
						now: NOW,
						run: {
							id: RUN_ID,
							startedBy: `${LONG_PERSON} via ${LONG_WORD}`,
							origin: {
								kind: 'assistant',
								assistant: LONG_WORD,
								verified: false,
								reason: LONG_WORD,
								expiresIso: new Date(NOW + 9 * 60_000).toISOString(),
								decision: { kind: 'pending' }
							},
							startedIso: new Date(NOW).toISOString(),
							endedIso: null,
							status: 'pending-approval',
							timeoutMs: 600_000,
							scripts: [{ osFamily: 'windows', shell: 'powershell', command: LONG_COMMAND }],
							machines: [],
							counts: {
								waiting: 1,
								running: 0,
								succeeded: 0,
								failed: 0,
								'timed-out': 0,
								offline: 0,
								skipped: 0,
								lost: 0,
								cancelled: 0
							},
							canCancel: true
						},
						approval: {
							kind: 'card',
							view: {
								runId: RUN_ID,
								requestedBy: LONG_PERSON,
								assistant: LONG_WORD,
								verified: false,
								reason: `${LONG_WORD} ${LONG_WORD}`,
								requestedIso: new Date(NOW).toISOString(),
								expiresIso: new Date(NOW + 9 * 60_000).toISOString(),
								osFamily: 'windows',
								shell: 'powershell',
								command: `${LONG_COMMAND}\u200B ${'x'.repeat(3000)}`,
								timeoutMs: 600_000,
								machines: [
									{ id: MACHINE_GROUP_ID, name: LONG_MACHINE_NAME, plan: 'runs' },
									{ id: USER_GROUP_ID, name: LONG_HOSTNAME, plan: 'agent-too-old' }
								],
								decide: { kind: 'yes', signIn: { kind: 'password' } }
							}
						}
					}
				},
				AS_APPROVER
			)
	}
];

beforeEach(stubPhoneServer);

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
