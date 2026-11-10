import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { InputMessage } from '#lib/domain/desktop/messages.ts';
import type { DesktopMode } from '#lib/domain/sessions/session.ts';
import '#lib/ui/design-tokens.css';
import FloatingControls from './floating-controls.svelte';

// SPEC-DESKTOP-FLOATING F2, F3, F4, F5, F6, F7, F9.

const STORAGE_KEY = 'bmuster.desktop.floatingButton';
/** The gap between the button and the screen's edge (`--space-3`). */
const EDGE = 12;

beforeEach(async () => {
	await page.viewport(375, 667);
	localStorage.clear();
});

afterEach(() => {
	localStorage.clear();
});

async function setup(mode: DesktopMode | undefined) {
	const sent: InputMessage[] = [];
	const backToScreen = vi.fn();
	const onexit = vi.fn();
	const ondisconnect = vi.fn();
	const screen = await render(FloatingControls, {
		osFamily: 'windows',
		mode,
		canSwitch: true,
		touchMode: 'trackpad',
		displays: [],
		display: null,
		settings: { quality: 'auto', scale: 'fit', maxFps: 15 },
		send: (message: InputMessage) => {
			sent.push(message);
		},
		backToScreen,
		ontouchmode: vi.fn(),
		ondisplay: vi.fn(),
		onsettings: vi.fn(),
		onswitch: vi.fn(),
		onexit,
		ondisconnect
	});
	// The full-screen element the controls float over.
	screen.container.style.cssText =
		'position: fixed; inset: 0; width: 100vw; height: 100vh; background: black;';
	const button = screen.getByRole('button', { name: 'Session controls' });
	await expect.element(button).toBeVisible();
	return { screen, sent, backToScreen, onexit, ondisconnect, button };
}

function pointer(target: Element, type: string, x: number, y: number): void {
	target.dispatchEvent(
		new PointerEvent(type, {
			pointerId: 7,
			pointerType: 'touch',
			isPrimary: true,
			clientX: x,
			clientY: y,
			bubbles: true,
			cancelable: true
		})
	);
}

describe('the floating controls', () => {
	it('F4: a tap opens the sheet; a second tap or a tap outside closes it', async () => {
		const { screen, button } = await setup('control');
		const sheet = screen.getByRole('group', { name: 'Session options' });
		await expect.element(sheet).not.toBeInTheDocument();
		await button.click();
		await expect.element(sheet).toBeVisible();
		await expect.element(button).toHaveAttribute('aria-expanded', 'true');
		await button.click();
		await expect.element(sheet).not.toBeInTheDocument();

		await button.click();
		await expect.element(sheet).toBeVisible();
		await screen
			.getByRole('button', { name: 'Close the controls' })
			.click({ position: { x: 5, y: 5 } });
		await expect.element(sheet).not.toBeInTheDocument();
	});

	it('F2, F3: a drag moves the button, snaps it to the nearer edge, and is remembered', async () => {
		const { screen, button } = await setup('control');
		const start = button.element().getBoundingClientRect();
		expect(start.right).toBeCloseTo(375 - EDGE, 0);

		const fab = button.element();
		pointer(fab, 'pointerdown', start.left + 24, start.top + 24);
		pointer(fab, 'pointermove', start.left + 20, start.top + 26);
		pointer(fab, 'pointermove', 120, 160);
		await expect.poll(() => fab.getBoundingClientRect().left).toBeCloseTo(120 - 24, 0);
		pointer(fab, 'pointermove', 100, 136);
		pointer(fab, 'pointerup', 100, 136);

		await expect.poll(() => fab.getBoundingClientRect().left).toBeCloseTo(EDGE, 0);
		expect(fab.getBoundingClientRect().top).toBeCloseTo(136 - 24, 0);
		// A drag is not a tap: the sheet stays closed.
		await expect
			.element(screen.getByRole('group', { name: 'Session options' }))
			.not.toBeInTheDocument();
		const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
		expect(saved).toMatchObject({ side: 'left' });
	});

	it('F2: a press that barely moves is still a tap', async () => {
		const { screen, button } = await setup('control');
		const fab = button.element();
		const at = fab.getBoundingClientRect();
		pointer(fab, 'pointerdown', at.left + 24, at.top + 24);
		pointer(fab, 'pointermove', at.left + 27, at.top + 27);
		pointer(fab, 'pointerup', at.left + 27, at.top + 27);
		expect(fab.getBoundingClientRect().left).toBeCloseTo(at.left, 0);
		await button.click();
		await expect.element(screen.getByRole('group', { name: 'Session options' })).toBeVisible();
	});

	it('F3: starts where this browser left it', async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ side: 'left', at: 0 }));
		const { button } = await setup('control');
		const at = button.element().getBoundingClientRect();
		expect(at.left).toBeCloseTo(EDGE, 0);
		expect(at.top).toBeCloseTo(EDGE, 0);
		expect(at.width).toBe(48);
		expect(at.height).toBe(48);
	});

	it('F5: a control session gets the actions, the phone keys and the Keys menu, which send as the menu does', async () => {
		const { screen, button, sent, backToScreen, onexit } = await setup('control');
		await button.click();
		const sheet = screen.getByRole('group', { name: 'Session options' });
		await expect.element(sheet.getByText('Control', { exact: true })).toBeVisible();
		for (const name of [
			/^Touch input/,
			'Picture settings',
			'Switch to view only (reconnects)',
			'Leave full screen',
			'Disconnect',
			'Show the keyboard'
		]) {
			await expect.element(sheet.getByRole('button', { name })).toBeVisible();
		}
		await expect.element(sheet.getByRole('toolbar', { name: 'Keys' })).toBeVisible();

		await sheet.getByRole('button', { name: /^Alt\+Tab/ }).click();
		expect(sent).toEqual([
			{ type: 'key', code: 'AltLeft', key: 'Alt', down: true, altGr: false },
			{ type: 'key', code: 'Tab', key: 'Tab', down: true, altGr: false },
			{ type: 'key', code: 'Tab', key: 'Tab', down: false, altGr: false },
			{ type: 'key', code: 'AltLeft', key: 'Alt', down: false, altGr: false }
		]);
		expect(backToScreen).toHaveBeenCalled();

		await sheet.getByRole('button', { name: 'Picture settings' }).click();
		await expect.element(sheet.getByRole('group', { name: 'Quality' })).toBeVisible();

		await sheet.getByRole('button', { name: 'Leave full screen' }).click();
		expect(onexit).toHaveBeenCalledOnce();
		await expect.element(sheet).not.toBeInTheDocument();
	});

	it('F6: a watch-only session gets no input mode, keyboard, phone keys or Keys menu', async () => {
		const { screen, button } = await setup('watch');
		await button.click();
		const sheet = screen.getByRole('group', { name: 'Session options' });
		await expect.element(sheet.getByText('View only', { exact: true })).toBeVisible();
		await expect.element(sheet.getByRole('button', { name: 'Leave full screen' })).toBeVisible();
		await expect.element(sheet.getByRole('button', { name: 'Disconnect' })).toBeVisible();
		await expect
			.element(sheet.getByRole('button', { name: 'Take control (reconnects)' }))
			.toBeVisible();
		for (const name of [/^Touch input/, 'Show the keyboard', /^Alt\+Tab/, 'More']) {
			await expect.element(sheet.getByRole('button', { name })).not.toBeInTheDocument();
		}
		await expect.element(sheet.getByRole('toolbar', { name: 'Keys' })).not.toBeInTheDocument();
	});

	it('F7: on a 375×667 phone the sheet takes at most half the screen, upright and on its side', async () => {
		for (const [width, height] of [
			[375, 667],
			[667, 375]
		] as const) {
			await page.viewport(width, height);
			const { screen, button } = await setup('control');
			await button.click();
			const sheet = screen.getByRole('group', { name: 'Session options' });
			await expect.element(sheet).toBeVisible();
			const box = sheet.element().getBoundingClientRect();
			expect(box.height).toBeLessThanOrEqual(height / 2 + 1);
			expect(box.left).toBeGreaterThanOrEqual(0);
			expect(box.right).toBeLessThanOrEqual(width);
			expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
			// The sheet never covers the button.
			const fab = button.element().getBoundingClientRect();
			expect(box.bottom <= fab.top || box.top >= fab.bottom).toBe(true);
			await screen.unmount();
		}
	});

	it('F9: Show the keyboard keeps typing on the machine and folds the sheet to the key bar', async () => {
		const { screen, button, sent } = await setup('control');
		await button.click();
		const sheet = screen.getByRole('group', { name: 'Session options' });
		await sheet.getByRole('button', { name: 'Show the keyboard' }).click();
		const typing = screen.getByRole('textbox', { name: 'Type on the machine' });
		await expect.element(typing).toHaveFocus();
		await expect
			.element(sheet.getByRole('button', { name: 'Leave full screen' }))
			.not.toBeInTheDocument();
		await expect.element(sheet.getByRole('button', { name: /^Alt\+Tab/ })).not.toBeInTheDocument();
		await expect.element(sheet.getByRole('button', { name: 'Hide the keyboard' })).toBeVisible();

		await userEvent.keyboard('hi');
		expect(sent.filter((message) => message.type === 'text')).not.toEqual([]);
		await sheet.getByRole('button', { name: 'Escape', exact: true }).click();
		await expect.element(typing).toHaveFocus();
	});
});
