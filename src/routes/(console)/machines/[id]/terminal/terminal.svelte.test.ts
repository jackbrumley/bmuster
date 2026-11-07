import '../../../../../app.css';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { Grant } from '#lib/domain/access/access.ts';
import type { Machine } from '#lib/domain/machines/machine.ts';
import { FakeSocket } from '#tests/helpers/fake-socket.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import TerminalTab from './+page.svelte';
import TerminalInFrame from './terminal-in-frame.svelte';

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

async function openTerminal(framed = false) {
	const screen = framed
		? await render(TerminalInFrame, { pageProps: props() })
		: await render(TerminalTab, props());
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

/** A one-finger swipe on the terminal, moving `dy` pixels in steps; true if the page was told not to scroll. */
function swipeTerminal(container: HTMLElement, dy: number): boolean {
	const target = container.querySelector('.xterm-screen');
	if (target === null) throw new Error('no terminal screen');
	const box = target.getBoundingClientRect();
	const x = box.left + box.width / 2;
	const start = box.top + box.height / 2;
	const touch = (y: number) => new Touch({ identifier: 1, target, clientX: x, clientY: y });
	const send = (type: string, y: number | undefined) => {
		const touches = y === undefined ? [] : [touch(y)];
		const event = new TouchEvent(type, {
			touches,
			targetTouches: touches,
			changedTouches: [touch(y ?? start + dy)],
			bubbles: true,
			cancelable: true
		});
		target.dispatchEvent(event);
		return event.defaultPrevented;
	};
	send('touchstart', start);
	let prevented = false;
	const steps = 10;
	for (let step = 1; step <= steps; step++) {
		prevented = send('touchmove', start + (dy * step) / steps) || prevented;
	}
	send('touchend', undefined);
	return prevented;
}

function topRow(container: HTMLElement): string {
	return container.querySelector('.xterm-rows > div')?.textContent.trim() ?? '';
}

describe('the terminal on a phone', () => {
	it('swiping down on the terminal scrolls its history, not the page', async () => {
		const { screen, socket } = await openTerminal(true);
		const lines = Array.from({ length: 500 }, (_, index) => String(index + 1)).join('\r\n');
		socket.receive(new TextEncoder().encode(`${lines}\r\n`));
		await expect.poll(() => rows(screen.container)).toContain('500');
		const before = Number(topRow(screen.container));

		expect(swipeTerminal(screen.container, 200)).toBe(true);
		await expect.poll(() => Number(topRow(screen.container))).toBeLessThan(before);
		expect(window.scrollY).toBe(0);
	});

	it('in the alternate screen (less, vim) a swipe sends the arrow keys a mouse wheel would', async () => {
		const { screen, socket } = await openTerminal(true);
		socket.receive(new TextEncoder().encode('\x1b[?1049h\x1b[Hless'));
		await expect.poll(() => rows(screen.container)).toContain('less');
		expect(swipeTerminal(screen.container, 200)).toBe(true);
		await expect
			.poll(() => socket.typed().filter((typed) => typed === '\x1b[A').length)
			.toBeGreaterThan(0);
		expect(socket.typed().every((typed) => typed === '\x1b[A')).toBe(true);
	});

	it('runs the full width of a 390px screen, without a sideways scroll', async () => {
		const { screen } = await openTerminal(true);
		const region = screen.getByRole('region', { name: `Terminal on ${MACHINE.name}` });
		await expect.element(region).toBeVisible();
		// The body's width: the test page keeps room for a scrollbar.
		const box = region.element().getBoundingClientRect();
		expect(box.left).toBe(0);
		expect(box.right).toBe(document.body.clientWidth);
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
		const bar = screen
			.getByRole('button', { name: 'Bigger text' })
			.element()
			.getBoundingClientRect();
		expect(bar.right).toBeLessThanOrEqual(document.body.clientWidth - 16);
	});
});
