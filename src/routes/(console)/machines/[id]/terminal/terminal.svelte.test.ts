import '../../../../../app.css';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { Grant } from '#lib/domain/access/access.ts';
import type { Machine } from '#lib/domain/machines/machine.ts';
import { FakeSocket } from '#tests/helpers/fake-socket.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import TerminalTab from './+page.svelte';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';

const MACHINE: Machine = TEST_MACHINE;

const GRANTS: Grant[] = [
	{ permission: 'view', consent: 'unattended' },
	{ permission: 'terminal', consent: 'unattended' }
];

const requests: { url: string; body: unknown }[] = [];

beforeEach(async () => {
	await page.viewport(390, 844);
	sessionStorage.clear();
	requests.length = 0;
	FakeSocket.last = undefined;
	vi.stubGlobal('WebSocket', FakeSocket);
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			requests.push({
				url,
				body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
			});
			return Promise.resolve(
				Response.json({ sessionId: SESSION_ID, browserTicket: 'ticket-1' }, { status: 200 })
			);
		})
	);
});

afterEach(() => {
	sessionStorage.clear();
});

function props() {
	return {
		params: { id: MACHINE.id },
		form: undefined,
		data: {
			user: { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'admin' as const },
			localNetworkMode: false,
			now: Date.parse('2026-11-07T12:00:00.000Z'),
			machine: MACHINE,
			grants: GRANTS
		}
	};
}

async function openTerminal() {
	const screen = await render(TerminalTab, props());
	await expect.poll(() => FakeSocket.last?.url ?? '').toContain('ticket=ticket-1');
	const socket = FakeSocket.last;
	if (socket === undefined) throw new Error('no socket');
	socket.receive(JSON.stringify({ type: 'attached', resumed: false }));
	socket.receive(JSON.stringify({ type: 'ready' }));
	return { screen, socket };
}

function rows(container: HTMLElement): string {
	return container.querySelector('.xterm-rows')?.textContent ?? '';
}

describe('the terminal tab (T1)', () => {
	it('opens a shell session, connects with the ticket and shows what the machine sends', async () => {
		const { screen, socket } = await openTerminal();
		expect(requests[0]?.url).toBe(`/api/machines/${MACHINE.id}/sessions`);
		expect(requests[0]?.body).toMatchObject({ kind: 'terminal', shell: 'bash' });
		expect(socket.url).toMatch(new RegExp(`/api/sessions/${SESSION_ID}/socket\\?ticket=ticket-1$`));

		socket.receive(new TextEncoder().encode('$ echo $((6*7))\r\n42\r\n'));
		await expect.poll(() => rows(screen.container)).toContain('42');
		await expect
			.poll(() => screen.getByRole('status').element().textContent)
			.toMatch(/^Session · \d\d:\d\d$/);
	});

	it("keeps xterm's hidden text box at 16px or more, so tapping it never zooms an iPhone", async () => {
		const { screen } = await openTerminal();
		const box = screen.container.querySelector('.xterm-helper-textarea');
		if (box === null) throw new Error('no xterm text box');
		expect(Number.parseFloat(getComputedStyle(box).fontSize)).toBeGreaterThanOrEqual(16);
	});

	it('remembers the running session in this tab, so a reload comes back to it', async () => {
		await openTerminal();
		const saved = sessionStorage.getItem(`bmuster.terminal.${MACHINE.id}`) ?? '';
		expect(JSON.parse(saved)).toMatchObject({ sessionId: SESSION_ID, tag: 'bash' });
	});

	it('says how the session ended and offers a new one', async () => {
		const { screen, socket } = await openTerminal();
		socket.receive(
			JSON.stringify({
				type: 'ended',
				reason: 'exited',
				message: 'The shell exited with code 0.'
			})
		);
		await expect.element(screen.getByText('The shell exited with code 0.')).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Start a new session' })).toBeVisible();
		expect(sessionStorage.getItem(`bmuster.terminal.${MACHINE.id}`)).toBeNull();
	});
});

describe('the extra keys (T5)', () => {
	it('send Esc, Tab, arrows and symbols', async () => {
		const { screen, socket } = await openTerminal();
		for (const name of ['Escape', 'Tab', 'Up arrow', 'Left arrow', 'Pipe', 'Tilde', 'Slash']) {
			await screen.getByRole('button', { name, exact: true }).click();
		}
		await expect
			.poll(() => socket.typed())
			.toEqual(['\x1b', '\t', '\x1b[A', '\x1b[D', '|', '~', '/']);
	});

	it('Ctrl and Alt act on the next key only', async () => {
		const { screen, socket } = await openTerminal();
		const ctrl = screen.getByRole('button', { name: 'Control (applies to the next key)' });
		const alt = screen.getByRole('button', { name: 'Alt (applies to the next key)' });

		await ctrl.click();
		await expect.element(ctrl).toHaveAttribute('aria-pressed', 'true');
		await screen.getByRole('button', { name: 'Left arrow' }).click();
		await expect.element(ctrl).toHaveAttribute('aria-pressed', 'false');

		await ctrl.click();
		const input = screen.container.querySelector('textarea');
		if (input === null) throw new Error('no terminal input');
		input.focus();
		await userEvent.keyboard('c');

		await alt.click();
		input.focus();
		await userEvent.keyboard('b');
		await userEvent.keyboard('x');

		await expect.poll(() => socket.typed()).toEqual(['\x1b[1;5D', '\x03', '\x1bb', 'x']);
	});
});
