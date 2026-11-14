import '../../../../app.css';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { SavedCommandEntry, SavedCommandView } from '#lib/domain/commands/saved-commands.ts';
import type { RecheckRequest } from '#lib/schemas/auth/recheck.ts';
import { confirmation } from '#lib/ui/confirm-action.svelte.ts';
import SavedListPage from './+page.svelte';
import SavedCommandForm from './saved-command-form.svelte';
import RunSavedCommand from './[id=uuid]/run/run-saved-command.svelte';
import SavedCommandChoice from '../new/saved-command-choice.svelte';

/**
 * SPEC-SAVED-COMMANDS SC1, SC2, SC4, SC6, SC9–SC11 in the browser: the Saved commands tab, the
 * admin's form, a person's run screen and Review, and Run command's saved command choice.
 */

const goto = vi.hoisted(() => vi.fn((_url: string, _options?: unknown) => Promise.resolve()));
vi.mock('$app/navigation', () => ({ goto, refreshAll: () => Promise.resolve() }));
vi.mock('$app/state', () => ({
	page: { url: new URL('https://bmuster.example.com/commands/saved'), params: {}, state: {} }
}));

const ID = '30303030-3030-4030-8030-303030303030';
const GROUP = '31313131-3131-4131-8131-313131313131';
const MINT = '32323232-3232-4232-8232-323232323232';
const WEB = '33333333-3333-4333-8333-333333333333';
const OFFICE = '34343434-3434-4434-8434-343434343434';
const RUN = '35353535-3535-4535-8535-353535353535';
const ADMIN = { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'admin' } as const;
const CONSOLE = {
	user: ADMIN,
	localNetworkMode: false,
	serverUpdate: null,
	runCommands: true,
	assistant: { kind: 'none' as const },
	approvals: { kind: 'hidden' as const },
	signedIn: true
};

function entry(overrides: Partial<SavedCommandEntry> = {}): SavedCommandEntry {
	return {
		id: ID,
		name: 'Service status',
		description: 'Whether a service is running.',
		effect: 'reads-only',
		systems: ['linux'],
		enabled: true,
		aiUnattended: false,
		version: 3,
		machineIds: [MINT],
		...overrides
	};
}

/** Records every request and answers each route as the server would. */
function stubServer(replies: Record<string, unknown>) {
	const sent: { url: string; method: string; body: unknown }[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			sent.push({
				url,
				method: init.method ?? 'GET',
				body: JSON.parse(typeof init.body === 'string' ? init.body : 'null')
			});
			const key = Object.keys(replies).find((suffix) => url.endsWith(suffix));
			return Promise.resolve(Response.json(key === undefined ? {} : replies[key]));
		})
	);
	return sent;
}

async function answer(yes: { recheck: RecheckRequest } | null): Promise<string> {
	await expect.poll(() => confirmation.current.kind).toBe('asking');
	const current = confirmation.current;
	if (current.kind !== 'asking') throw new Error('not asking');
	const title = current.options.title;
	current.answer(yes === null ? { kind: 'no' } : { kind: 'yes', recheck: yes.recheck });
	return title;
}

beforeEach(async () => {
	goto.mockClear();
	confirmation.current = { kind: 'none' };
	await page.viewport(1280, 800);
});

describe('the Saved commands tab (SC1)', () => {
	it('SC1: an admin sees every command, Off and AI tags, opens its form, and adds new ones', async () => {
		const screen = await render(SavedListPage, {
			params: {},
			form: undefined,
			data: {
				...CONSOLE,
				canWrite: true,
				commands: [
					entry({ enabled: false }),
					entry({ id: GROUP, name: 'Restart spooler', effect: 'changes', aiUnattended: true })
				]
			}
		});
		const links = screen.getByRole('list', { name: 'Saved commands' }).getByRole('link');
		await expect.element(links.first()).toHaveAttribute('href', `/commands/saved/${ID}`);
		expect(links.first().element().textContent).toContain('Off');
		expect(links.nth(1).element().textContent).toContain('Changes the machine');
		expect(links.nth(1).element().textContent).toContain('AI runs it without approval');
		const warned = links.nth(1).element().querySelectorAll('.warn');
		expect(warned).toHaveLength(2);
		await screen.getByRole('button', { name: 'New saved command' }).click();
		expect(goto).toHaveBeenCalledWith('/commands/saved/new');
	});

	it('SC1: anyone else opens the run screen, and cannot add one', async () => {
		const screen = await render(SavedListPage, {
			params: {},
			form: undefined,
			data: { ...CONSOLE, canWrite: false, commands: [entry()] }
		});
		await expect
			.element(screen.getByRole('link', { name: /Service status/ }))
			.toHaveAttribute('href', `/commands/saved/${ID}/run`);
		expect(screen.getByRole('button', { name: 'New saved command' }).query()).toBeNull();
	});
});

const VIEW: SavedCommandView = {
	id: ID,
	name: 'Restart spooler',
	description: 'Restarts the print spooler.',
	effect: 'changes',
	systems: ['windows'],
	enabled: true,
	aiUnattended: false,
	version: 3,
	scripts: [{ osFamily: 'windows', shell: 'powershell', script: 'Restart-Service Spooler' }],
	parameters: [],
	machineGroupIds: [GROUP],
	timeoutMs: 60_000
};

describe('the saved command form (SC2, SC4, SC6)', () => {
	it('SC6: letting AI run a command that changes the machine is confirmed, and shown in the warning colour', async () => {
		stubServer({});
		const screen = await render(SavedCommandForm, {
			initial: { kind: 'edit', command: VIEW },
			groups: [{ id: GROUP, name: 'Print servers' }],
			signIn: { kind: 'recent' }
		});
		const ai = screen.getByRole('group', { name: 'AI may run this without approval' });
		await ai.getByRole('button', { name: 'On' }).click();
		expect(await answer(null)).toBe('Let AI change machines without approval?');
		await expect
			.element(ai.getByRole('button', { name: 'Off' }))
			.toHaveAttribute('aria-pressed', 'true');
		await ai.getByRole('button', { name: 'On' }).click();
		await answer({ recheck: { kind: 'none' } });
		await expect
			.element(ai.getByRole('button', { name: 'On' }))
			.toHaveAttribute('aria-pressed', 'true');
		expect(ai.element().closest('.warn')).not.toBeNull();
	});

	it('SC2: the form checks with the server’s schema before anything is sent', async () => {
		const sent = stubServer({});
		const screen = await render(SavedCommandForm, {
			initial: { kind: 'new' },
			groups: [{ id: GROUP, name: 'Print servers' }],
			signIn: { kind: 'recent' }
		});
		await screen.getByRole('button', { name: 'Save' }).click();
		await expect.element(screen.getByText('Give it a name.')).toBeVisible();
		await expect.element(screen.getByText('Say what it does.')).toBeVisible();
		await expect.element(screen.getByText('Choose at least one machine group.')).toBeVisible();
		expect(sent).toEqual([]);
	});

	it('SC4: saving asks for the password when the sign-in is not recent, and sends the command', async () => {
		const sent = stubServer({ '/api/commands/saved': { id: ID, version: 1 } });
		const screen = await render(SavedCommandForm, {
			initial: { kind: 'new' },
			groups: [{ id: GROUP, name: 'Print servers' }],
			signIn: { kind: 'password' }
		});
		await screen.getByRole('textbox', { name: 'Name' }).fill('Service status');
		await screen.getByRole('textbox', { name: /^Description/ }).fill('Whether a service runs.');
		await screen.getByRole('button', { name: 'Print servers' }).click();
		await screen
			.getByRole('group', { name: 'Windows shell' })
			.getByRole('button', { name: 'No script' })
			.click();
		await screen
			.getByRole('textbox', { name: 'Linux script' })
			.fill('systemctl status "$BMUSTER_PARAM_SERVICE"');
		await screen.getByRole('button', { name: 'Add parameter' }).click();
		await screen.getByRole('textbox', { name: /^Name \(lower case/ }).fill('service');
		await screen.getByRole('textbox', { name: 'Label', exact: true }).fill('Service');
		await screen.getByRole('button', { name: 'Save' }).click();
		expect(await answer({ recheck: { kind: 'password', password: 'secret' } })).toBe(
			'Save Service status?'
		);
		await expect.poll(() => sent.length).toBe(1);
		expect(sent[0]).toMatchObject({
			method: 'POST',
			body: {
				command: {
					name: 'Service status',
					scripts: [{ osFamily: 'linux', shell: 'sh' }],
					machineGroupIds: [GROUP],
					parameters: [
						{ kind: 'text', name: 'service', label: 'Service', pattern: 'service-name' }
					],
					enabled: false,
					aiUnattended: false
				},
				recheck: { kind: 'password', password: 'secret' }
			}
		});
		await expect.poll(() => goto.mock.calls.length).toBe(1);
	});
});

const RUN_COMMAND = {
	id: ID,
	name: 'Recent system errors',
	description: 'Errors logged in the last few hours.',
	effect: 'reads-only' as const,
	version: 3,
	parameters: [{ kind: 'number' as const, name: 'hours', label: 'Hours', min: 1, max: 72 }],
	timeoutMs: 120_000
};

describe('running a saved command (SC10, SC11)', () => {
	it('SC10: one field per parameter, checked as the server checks; only its machines; the selection ticked', async () => {
		const sent = stubServer({});
		const screen = await render(RunSavedCommand, {
			command: RUN_COMMAND,
			machines: [
				{ id: MINT, name: 'mint', osFamily: 'linux' },
				{ id: WEB, name: 'web-1', osFamily: 'linux' }
			],
			ticked: [MINT, OFFICE]
		});
		await expect.element(screen.getByText('Errors logged in the last few hours.')).toBeVisible();
		await expect.element(screen.getByRole('checkbox', { name: 'mint (Linux)' })).toBeChecked();
		await expect.element(screen.getByRole('checkbox', { name: 'web-1 (Linux)' })).not.toBeChecked();
		await expect.element(screen.getByText('Machines (1 ticked)')).toBeVisible();
		await screen.getByRole('textbox', { name: 'Hours (1 to 72)' }).fill('100');
		await screen.getByRole('button', { name: 'Review' }).click();
		await expect.element(screen.getByText('Hours is 1 to 72.')).toBeVisible();
		expect(sent).toEqual([]);
	});

	it('SC11: Review shows the exact command and machines; Run confirms with the count and the password', async () => {
		const command =
			"# BMuster: saved command parameters\nexport BMUSTER_PARAM_HOURS='24'\n\njournalctl -p err";
		const sent = stubServer({
			'/plan': {
				commands: [{ osFamily: 'linux', shell: 'sh', command }],
				machines: [
					{ id: MINT, name: 'mint', osFamily: 'linux', plan: { kind: 'runs' } },
					{
						id: WEB,
						name: 'web-1',
						osFamily: 'linux',
						plan: { kind: 'skipped', reason: 'offline' }
					}
				],
				signIn: { kind: 'password' }
			},
			'/runs': { runId: RUN }
		});
		const screen = await render(RunSavedCommand, {
			command: RUN_COMMAND,
			machines: [
				{ id: MINT, name: 'mint', osFamily: 'linux' },
				{ id: WEB, name: 'web-1', osFamily: 'linux' }
			],
			ticked: []
		});
		await screen.getByRole('button', { name: 'Select all 2' }).click();
		await screen.getByRole('textbox', { name: 'Hours (1 to 72)' }).fill('24');
		await screen.getByRole('button', { name: 'Review' }).click();
		await expect.element(screen.getByText(/journalctl -p err/)).toBeVisible();
		expect(screen.getByText(/journalctl -p err/).element().textContent).toBe(command);
		await expect
			.element(screen.getByRole('list', { name: 'Will run' }).getByText('mint'))
			.toBeVisible();
		await expect
			.element(screen.getByRole('list', { name: 'Will be skipped' }).getByText('Offline'))
			.toBeVisible();
		expect(sent[0]).toMatchObject({
			url: `/api/commands/saved/${ID}/plan`,
			body: { version: 3, machineIds: [MINT, WEB], values: { hours: '24' } }
		});
		await screen.getByRole('button', { name: 'Run' }).click();
		expect(await answer({ recheck: { kind: 'password', password: 'secret' } })).toBe(
			'Run on 2 machines?'
		);
		await expect.poll(() => sent.length).toBe(2);
		expect(sent[1]).toMatchObject({
			url: `/api/commands/saved/${ID}/runs`,
			body: {
				version: 3,
				machineIds: [MINT, WEB],
				values: { hours: '24' },
				confirmCount: 2,
				recheck: { kind: 'password', password: 'secret' }
			}
		});
		await expect.poll(() => goto.mock.calls[0]?.[0]).toBe(`/commands/${RUN}`);
	});
});

describe('Run command’s saved command choice (SC9)', () => {
	it('SC9: the switched-on saved commands that can run on the selection; picking one carries the selection', async () => {
		stubServer({
			'/api/commands/saved': {
				commands: [
					entry(),
					entry({ id: GROUP, name: 'Off one', enabled: false }),
					entry({ id: RUN, name: 'Elsewhere', machineIds: [WEB] })
				]
			}
		});
		const screen = await render(SavedCommandChoice, { machineIds: [MINT, OFFICE] });
		const list = screen.getByRole('list', { name: 'Saved commands for these machines' });
		await expect.element(list.getByText('Service status')).toBeVisible();
		await expect.element(list.getByText(/runs on 1 of 2 selected/)).toBeVisible();
		expect(list.getByText('Off one').query()).toBeNull();
		expect(list.getByText('Elsewhere').query()).toBeNull();
		await list.getByRole('button').click();
		expect(goto).toHaveBeenCalledWith(`/commands/saved/${ID}/run`, {
			state: { savedRunDraft: { machineIds: [MINT, OFFICE] } }
		});
	});
});
