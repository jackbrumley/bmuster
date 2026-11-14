import '../../app.css';
import { afterEach, beforeEach, describe, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { GrantView } from '#lib/domain/mcp/mcp.ts';
import {
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
import AiAssistantsPage from './settings/ai-assistants/+page.svelte';
import {
	CONSOLE,
	checkPhoneWidth,
	IN_CONSOLE,
	stubPhoneServer,
	type PhonePage
} from './phone-overflow-harness.ts';

/**
 * SPEC-MCP M16 (SPEC-PHONE-LAYOUT U1): connecting an AI assistant works on a 360 px phone with the
 * longest names: the consent screen, the Account page and Settings → AI assistants. Kept apart
 * from phone-overflow.svelte.test.ts, which is at its size limit; the setup is the same harness.
 */

vi.mock('$app/navigation', () => ({ refreshAll: () => Promise.resolve(), goto: vi.fn() }));
vi.mock('$app/state', () => ({
	page: {
		url: new URL('https://bmuster.example-company.com.au/settings/ai-assistants'),
		route: { id: '/(console)/settings/ai-assistants' },
		params: {},
		status: 200,
		error: null
	}
}));

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
						grants: GRANTS
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
						grants: GRANTS,
						serverUrl: `https://${LONG_HOSTNAME}/mcp`
					}
				},
				IN_CONSOLE
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
