import type { RecheckRequest } from '#lib/schemas/auth/recheck.ts';
import '../../../../app.css';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { PlannedMachine } from '#lib/domain/commands/commands.ts';
import type { SignInCheck } from '#lib/domain/auth/sign-in-check.ts';
import { confirmation } from '#lib/ui/confirm-action.svelte.ts';
import RunCommand from './run-command.svelte';

const goto = vi.hoisted(() => vi.fn((_url: string) => Promise.resolve()));
vi.mock('$app/navigation', () => ({ goto }));

const RUN_ID = '99999999-9999-4999-8999-999999999999';

function id(index: number): string {
	return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function planned(
	index: number,
	osFamily: PlannedMachine['osFamily'],
	plan: PlannedMachine['plan']
): PlannedMachine {
	return { id: id(index), name: `PC ${index}`, osFamily, plan };
}

const RUNS = { kind: 'runs' } as const;

/** The server: answers the plan, and records what Run sends. */
function stubServer(machines: PlannedMachine[], signIn: SignInCheck) {
	const sent: unknown[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			if (url.endsWith('/api/commands/plan')) {
				return Promise.resolve(Response.json({ machines, signIn }));
			}
			sent.push(JSON.parse(typeof init.body === 'string' ? init.body : 'null'));
			return Promise.resolve(Response.json({ runId: RUN_ID }, { status: 201 }));
		})
	);
	return sent;
}

function draft(machineIds: string[]) {
	return { machineIds, scripts: [], timeoutMs: 60_000, rerunOf: null };
}

async function answer(yes: { typed: string; recheck: RecheckRequest } | null): Promise<void> {
	await expect.poll(() => confirmation.current.kind).toBe('asking');
	const current = confirmation.current;
	if (current.kind !== 'asking') throw new Error('not asking');
	current.answer(yes === null ? { kind: 'no' } : { kind: 'yes', recheck: yes.recheck });
}

beforeEach(async () => {
	goto.mockClear();
	confirmation.current = { kind: 'none' };
	await page.viewport(1280, 800);
});

describe('Run command (SPEC-COMMANDS C6, C8, C9)', () => {
	it('C6: one command box per system in the selection, each with its count and shells', async () => {
		stubServer(
			[planned(1, 'windows', RUNS), planned(2, 'windows', RUNS), planned(3, 'linux', RUNS)],
			{ kind: 'recent' }
		);
		const screen = await render(RunCommand, { draft: draft([id(1), id(2), id(3)]) });
		await expect
			.element(screen.getByRole('textbox', { name: 'Windows command (2 machines)' }))
			.toBeVisible();
		await expect
			.element(screen.getByRole('textbox', { name: 'Linux command (1 machine)' }))
			.toBeVisible();
		const windowsShell = screen.getByRole('group', { name: 'Windows shell' });
		await expect
			.element(windowsShell.getByRole('button', { name: 'PowerShell' }))
			.toHaveAttribute('aria-pressed', 'true');
		await expect.element(windowsShell.getByRole('button', { name: 'cmd' })).toBeVisible();
		const linuxShell = screen.getByRole('group', { name: 'Linux shell' });
		await expect.element(linuxShell.getByRole('button', { name: 'sh' })).toBeVisible();
		await expect.element(linuxShell.getByRole('button', { name: 'bash' })).toBeVisible();
		await screen.unmount();

		stubServer([planned(1, 'linux', RUNS)], { kind: 'recent' });
		const one = await render(RunCommand, { draft: draft([id(1)]) });
		await expect
			.element(one.getByRole('textbox', { name: 'Linux command (1 machine)' }))
			.toBeVisible();
		expect(one.container.querySelectorAll('textarea')).toHaveLength(1);
	});

	it('C8: Review shows each command in full, its shell, the time limit, who runs it and who is skipped', async () => {
		const sent = stubServer(
			[
				planned(1, 'linux', RUNS),
				planned(2, 'linux', { kind: 'skipped', reason: 'offline' }),
				planned(3, 'linux', { kind: 'skipped', reason: 'agent-too-old' }),
				planned(4, 'linux', { kind: 'skipped', reason: 'no-permission' })
			],
			{ kind: 'recent' }
		);
		const screen = await render(RunCommand, {
			draft: draft([id(1), id(2), id(3), id(4)])
		});
		const box = screen.getByRole('textbox', { name: /^Linux command/ });
		await box.fill('systemctl restart cups\njournalctl -u cups -n 20');
		await screen
			.getByRole('group', { name: 'Linux shell' })
			.getByRole('button', { name: 'bash' })
			.click();
		// Nothing runs from this screen: only Review.
		expect(screen.getByRole('button', { name: 'Run' }).query()).toBeNull();
		await screen.getByRole('button', { name: 'Review' }).click();

		const command = screen.getByText(/systemctl restart cups/);
		await expect.element(command).toBeVisible();
		expect(command.element().textContent).toBe('systemctl restart cups\njournalctl -u cups -n 20');
		expect(getComputedStyle(command.element()).fontFamily).toMatch(/mono/i);
		await expect.element(screen.getByText('Linux · bash')).toBeVisible();
		await expect.element(screen.getByText('Time limit: 60 s')).toBeVisible();
		const runs = screen.getByRole('list', { name: 'Will run' });
		await expect.element(runs.getByText('PC 1')).toBeVisible();
		const skipped = screen.getByRole('list', { name: 'Will be skipped' });
		await expect.element(skipped.getByText('PC 2')).toBeVisible();
		await expect.element(skipped.getByText('Offline')).toBeVisible();
		await expect.element(skipped.getByText('Agent too old (update first)')).toBeVisible();
		await expect.element(skipped.getByText('You cannot run commands on it')).toBeVisible();
		expect(sent).toEqual([]);
	});

	it('C9: Run asks in a dialog naming the count and command; above 10 machines the count is typed', async () => {
		const machines = Array.from({ length: 12 }, (_, index) => planned(index + 1, 'windows', RUNS));
		const sent = stubServer(machines, { kind: 'password' });
		const screen = await render(RunCommand, {
			draft: draft(machines.map((machine) => machine.id))
		});
		await screen.getByRole('textbox', { name: /^Windows command/ }).fill('Restart-Service Spooler');
		await screen.getByRole('button', { name: 'Review' }).click();
		await screen.getByRole('button', { name: 'Run' }).click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		const asked = confirmation.current;
		if (asked.kind !== 'asking') throw new Error('not asking');
		expect(asked.options.title).toBe('Run on 12 machines?');
		expect(asked.options.message).toContain('Restart-Service Spooler');
		expect(asked.typed).toEqual({ kind: 'count', count: 12 });
		// Signed in more than 10 minutes ago: the same dialog asks for the password (C10).
		expect(asked.recheck).toBe('password');
		await answer({
			typed: '12',
			recheck: { kind: 'password', password: 'correct horse battery' }
		});
		await expect.poll(() => sent.length).toBe(1);
		expect(sent[0]).toMatchObject({
			machineIds: machines.map((machine) => machine.id),
			scripts: [{ osFamily: 'windows', shell: 'powershell', command: 'Restart-Service Spooler' }],
			timeoutMs: 60_000,
			confirmCount: 12,
			recheck: { kind: 'password', password: 'correct horse battery' },
			rerunOf: null
		});
		await expect.poll(() => goto.mock.calls.length).toBe(1);
		expect(goto).toHaveBeenCalledWith(`/commands/${RUN_ID}`);
	});

	it('C9: 10 or fewer machines confirm without typing; cancelling sends nothing', async () => {
		const sent = stubServer([planned(1, 'linux', RUNS), planned(2, 'linux', RUNS)], {
			kind: 'recent'
		});
		const screen = await render(RunCommand, { draft: draft([id(1), id(2)]) });
		await screen.getByRole('textbox', { name: /^Linux command/ }).fill('uptime');
		await screen.getByRole('button', { name: 'Review' }).click();
		await screen.getByRole('button', { name: 'Run' }).click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		const asked = confirmation.current;
		if (asked.kind !== 'asking') throw new Error('not asking');
		expect(asked.options.title).toBe('Run on 2 machines?');
		expect(asked.typed).toEqual({ kind: 'none' });
		expect(asked.recheck).toBe('none');
		await answer(null);
		expect(sent).toEqual([]);
	});

	it('SPEC-TWO-FACTOR TF13: with two-factor on, the dialog asks for an authenticator code', async () => {
		const sent = stubServer([planned(1, 'linux', RUNS)], { kind: 'code' });
		const screen = await render(RunCommand, { draft: draft([id(1)]) });
		await screen.getByRole('textbox', { name: /^Linux command/ }).fill('uptime');
		await screen.getByRole('button', { name: 'Review' }).click();
		await screen.getByRole('button', { name: 'Run' }).click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		const asked = confirmation.current;
		if (asked.kind !== 'asking') throw new Error('not asking');
		expect(asked.recheck).toBe('code');
		await answer({ typed: '', recheck: { kind: 'code', code: '123456' } });
		await expect.poll(() => sent.length).toBe(1);
		expect(sent[0]).toMatchObject({ recheck: { kind: 'code', code: '123456' } });
	});
});
