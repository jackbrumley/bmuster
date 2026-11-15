import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent, type Locator } from 'vitest/browser';
import type { Grant } from '#lib/domain/access/access.ts';
import { FakeSocket } from '#tests/helpers/fake-socket.ts';
import '#lib/ui/design-tokens.css';
import { openPopOut } from './desktop-test-harness.ts';

// SPEC-DESKTOP-FLOATING FB3, FB4, FB5, FB7: the floating bar and the button it collapses into,
// tried in the pop-out window, whose size the test sets.

const SESSION = '77777777-7777-4777-8777-777777777777';
const GRANTS: Grant[] = [
	{ permission: 'view', consent: 'unattended' },
	{ permission: 'desktop-view', consent: 'unattended' },
	{ permission: 'desktop-control', consent: 'unattended' }
];
/** The gap the controls keep from the window's edges (`--space-2` for the bar, `--space-3` for the button). */
const BAR_GAP = 8;
const BUTTON_GAP = 12;
const KEY = 'bmuster.desktop.controls.window';

let address = '';

beforeEach(async () => {
	await page.viewport(1200, 800);
	sessionStorage.clear();
	localStorage.clear();
	FakeSocket.last = undefined;
	vi.stubGlobal('WebSocket', FakeSocket);
	vi.stubGlobal(
		'fetch',
		vi.fn(() => Promise.resolve(Response.json({ kind: 'issued', browserTicket: 'moved-here' })))
	);
	address = window.location.href;
	history.replaceState(
		history.state,
		'',
		`${window.location.pathname}?sessionId=${SESSION}&mode=control&since=1794000000000`
	);
});

afterEach(() => {
	history.replaceState(history.state, '', address);
	sessionStorage.clear();
	localStorage.clear();
});

async function openWindow() {
	const { screen, socket } = await openPopOut(GRANTS);
	const bar = screen.getByRole('group', { name: 'Window controls' });
	const handle = screen.getByRole('button', { name: 'Collapse the controls' });
	const button = screen.getByRole('button', { name: /^Session controls/ });
	return { screen, socket, bar, handle, button };
}

function box(locator: Locator): DOMRect {
	return locator.element().getBoundingClientRect();
}

function mouse(target: Element, type: string, x: number, y: number): void {
	target.dispatchEvent(
		new PointerEvent(type, {
			pointerId: 1,
			pointerType: 'mouse',
			button: 0,
			isPrimary: true,
			clientX: x,
			clientY: y,
			bubbles: true,
			cancelable: true
		})
	);
}

/** Drags the bar by its handle so the handle's centre ends at (x, y), and lets go. */
function dragHandle(handle: Locator, x: number, y: number): void {
	const at = box(handle);
	const start = { x: at.left + at.width / 2, y: at.top + at.height / 2 };
	mouse(handle.element(), 'pointerdown', start.x, start.y);
	mouse(handle.element(), 'pointermove', start.x + 20, start.y + 20);
	mouse(handle.element(), 'pointermove', x, y);
	mouse(handle.element(), 'pointerup', x, y);
}

function pointerMessages(socket: FakeSocket): unknown[] {
	return socket
		.messages()
		.filter(
			(message) =>
				typeof message === 'object' &&
				message !== null &&
				'type' in message &&
				message.type === 'pointer'
		);
}

describe('the floating bar', () => {
	it('FB3: the handle drags the bar, which stays inside the window, also when it shrinks', async () => {
		const { socket, bar, handle } = await openWindow();
		await expect.element(bar).toBeVisible();
		// It starts at the top centre.
		expect(box(bar).top).toBeCloseTo(BAR_GAP, 0);
		expect(box(bar).left + box(bar).width / 2).toBeCloseTo(600, 0);

		dragHandle(handle, 400, 500);
		await expect.poll(() => box(handle).left + box(handle).width / 2).toBeCloseTo(400, 0);
		expect(box(handle).top + box(handle).height / 2).toBeCloseTo(500, 0);

		// Dragged past the corner, it stops at the window's edges.
		dragHandle(handle, 5000, 5000);
		await expect.poll(() => box(bar).right).toBeCloseTo(1200 - BAR_GAP, 0);
		expect(box(bar).bottom).toBeCloseTo(800 - BAR_GAP, 0);
		expect(pointerMessages(socket)).toEqual([]);

		// The window shrinks: the bar keeps to its corner, inside.
		await page.viewport(950, 600);
		await expect.poll(() => box(bar).right).toBeCloseTo(950 - BAR_GAP, 0);
		expect(box(bar).bottom).toBeCloseTo(600 - BAR_GAP, 0);
	});

	it('FB4: Enter on the handle collapses the bar; arrows move it; Space collapses it too', async () => {
		const { bar, handle, button } = await openWindow();
		await expect.element(bar).toBeVisible();
		handle.element().focus();
		const before = box(bar);
		await userEvent.keyboard('{ArrowDown}{ArrowDown}');
		await expect.poll(() => box(bar).top).toBeCloseTo(before.top + 32, 0);
		await userEvent.keyboard('{Shift>}{ArrowLeft}{/Shift}');
		await expect.poll(() => box(bar).left).toBeCloseTo(before.left - 64, 0);
		// Up is past the edge: it stops there.
		await userEvent.keyboard('{Shift>}{ArrowUp}{/Shift}');
		await expect.poll(() => box(bar).top).toBeCloseTo(BAR_GAP, 0);

		await userEvent.keyboard('{Enter}');
		await expect.element(bar).not.toBeInTheDocument();
		await expect.element(button).toHaveFocus();
		await userEvent.keyboard('{Enter}');
		await expect.element(bar).toBeVisible();
		await expect.element(handle).toHaveFocus();
		await userEvent.keyboard(' ');
		await expect.element(bar).not.toBeInTheDocument();
		await expect.element(button).toBeVisible();
	});

	it('FB5: a tap collapses the bar into the button at its end, and a tap on the button opens it there again', async () => {
		const { screen, bar, handle, button } = await openWindow();
		dragHandle(handle, 30, 5000);
		await expect.poll(() => box(bar).left).toBeCloseTo(BAR_GAP, 0);
		const placed = box(bar);

		await handle.click();
		await expect.element(bar).not.toBeInTheDocument();
		// The button sits at the bar's end nearer the edge: here the bottom-left corner.
		expect(box(button).left).toBeCloseTo(BUTTON_GAP, 0);
		expect(box(button).bottom).toBeCloseTo(800 - BUTTON_GAP, 0);
		// The focus goes back to the screen.
		await expect.element(screen.getByRole('application', { name: /Screen of/ })).toHaveFocus();

		await button.click();
		await expect.element(bar).toBeVisible();
		expect(box(bar).left).toBeCloseTo(placed.left, 0);
		expect(box(bar).bottom).toBeCloseTo(placed.bottom, 0);

		// Collapsed and dragged to the right, the button snaps to the right edge; the bar opens from there.
		await handle.click();
		const fab = button.element();
		const at = fab.getBoundingClientRect();
		mouse(fab, 'pointerdown', at.left + 24, at.top + 24);
		mouse(fab, 'pointermove', 1100, 300);
		mouse(fab, 'pointerup', 1100, 300);
		await expect.poll(() => fab.getBoundingClientRect().right).toBeCloseTo(1200 - BUTTON_GAP, 0);
		const snappedTo = fab.getBoundingClientRect();
		await button.click();
		await expect.element(bar).toBeVisible();
		expect(box(bar).right).toBeCloseTo(1200 - BAR_GAP, 0);
		expect(box(bar).top).toBeCloseTo(snappedTo.top, -1);
	});

	it('FB7: the bar or the button, and their places, are remembered for the pop-out', async () => {
		const first = await openWindow();
		dragHandle(first.handle, 200, 400);
		await first.handle.click();
		await expect.element(first.button).toBeVisible();
		const where = box(first.button);
		const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? 'null');
		expect(saved).toMatchObject({ shown: 'button' });
		expect(localStorage.getItem('bmuster.desktop.controls.full-screen')).toBeNull();
		await first.screen.unmount();

		const again = await openWindow();
		await expect.element(again.button).toBeVisible();
		await expect.element(again.bar).not.toBeInTheDocument();
		expect(box(again.button).left).toBeCloseTo(where.left, 0);
		expect(box(again.button).top).toBeCloseTo(where.top, 0);
	});
});
