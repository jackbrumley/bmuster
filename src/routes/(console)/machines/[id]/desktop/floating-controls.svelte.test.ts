import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { InputMessage } from '#lib/domain/desktop/messages.ts';
import type { DesktopMode } from '#lib/domain/sessions/session.ts';
import '#lib/ui/design-tokens.css';
import FloatingControls from './floating-controls.svelte';

// SPEC-DESKTOP-FLOATING F2, F3, F4, F6, FA1, FA4, FA5, FA6, FA7, FA8, FA9.

const TWO_SCREENS = [
	{ value: 'L', label: 'Left', count: undefined },
	{ value: 'R', label: 'Right', count: undefined }
];

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

async function setup(
	mode: DesktopMode | undefined,
	displays: readonly { value: string; label: string; count: undefined }[] = []
) {
	const sent: InputMessage[] = [];
	const backToScreen = vi.fn();
	const onexit = vi.fn();
	const ondisconnect = vi.fn();
	const screen = await render(FloatingControls, {
		osFamily: 'windows',
		mode,
		canSwitch: true,
		touchMode: 'trackpad',
		displays,
		display: null,
		settings: { quality: 'auto', scale: 'fit', maxFps: 15 },
		agentVersion: '0.4.17',
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

/** Drags the button with a finger from its centre to (x, y) and lets go. */
function dragTo(fab: Element, x: number, y: number): void {
	const start = fab.getBoundingClientRect();
	pointer(fab, 'pointerdown', start.left + 24, start.top + 24);
	pointer(fab, 'pointermove', x, y);
	pointer(fab, 'pointerup', x, y);
}

describe('the floating controls', () => {
	it('F4, FA8: a tap opens the sheet; a second tap, a tap outside or Escape closes it', async () => {
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

		await button.click();
		await sheet.getByRole('tab', { name: 'Session' }).click();
		await userEvent.keyboard('{Escape}');
		await expect.element(sheet).not.toBeInTheDocument();
		await expect.element(button).toHaveFocus();
	});

	it('F2, F3: a drag moves the button, snaps it to the nearest edge, and is remembered', async () => {
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
		expect(saved).toMatchObject({ edge: 'left' });
	});

	it('FA1: a drag to the top lands the button on the top edge, where it stays next time', async () => {
		const first = await setup('control');
		const fab = first.button.element();
		dragTo(fab, 200, 30);
		await expect.poll(() => fab.getBoundingClientRect().top).toBeCloseTo(EDGE, 0);
		expect(fab.getBoundingClientRect().left).toBeCloseTo(200 - 24, 0);
		const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
		expect(saved).toMatchObject({ edge: 'top' });
		await first.screen.unmount();

		const again = await setup('control');
		const at = again.button.element().getBoundingClientRect();
		expect(at.top).toBeCloseTo(EDGE, 0);
		expect(at.left).toBeCloseTo(200 - 24, 0);
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
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ edge: 'left', at: 0 }));
		const { button } = await setup('control');
		const at = button.element().getBoundingClientRect();
		expect(at.left).toBeCloseTo(EDGE, 0);
		expect(at.top).toBeCloseTo(EDGE, 0);
		expect(at.width).toBe(48);
		expect(at.height).toBe(48);
	});

	it('FA4: a bottom sheet on an upright phone, a full-height side panel on its side', async () => {
		const portrait = await setup('control');
		await portrait.button.click();
		const tall = portrait.screen.getByRole('group', { name: 'Session options' });
		await expect.element(tall).toBeVisible();
		const bottom = tall.element().getBoundingClientRect();
		expect(bottom.left).toBeCloseTo(EDGE, 0);
		expect(bottom.right).toBeCloseTo(375 - EDGE, 0);
		expect(bottom.bottom).toBeCloseTo(667 - EDGE, 0);
		expect(bottom.height).toBeLessThanOrEqual((667 - 2 * EDGE) * 0.7 + 1);
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
		await portrait.screen.unmount();

		await page.viewport(667, 375);
		for (const [stored, side] of [
			[{ edge: 'right', at: 0.5 }, 'right'],
			[{ edge: 'top', at: 0.1 }, 'left']
		] as const) {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
			const landscape = await setup('control');
			await landscape.button.click();
			const wide = landscape.screen.getByRole('group', { name: 'Session options' });
			await expect.element(wide).toBeVisible();
			const panel = wide.element().getBoundingClientRect();
			expect(panel.top).toBeCloseTo(EDGE, 0);
			expect(panel.bottom).toBeCloseTo(375 - EDGE, 0);
			expect(panel.width).toBeLessThanOrEqual(Math.min(380, (667 - 2 * EDGE) / 2) + 1);
			if (side === 'right') {
				expect(panel.right).toBeCloseTo(667 - EDGE, 0);
			} else {
				expect(panel.left).toBeCloseTo(EDGE, 0);
			}
			expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(667);
			await landscape.screen.unmount();
		}
	});

	it('FA5: a control session has Keys, Picture and Session tabs and opens on Keys', async () => {
		const { screen, button, onexit } = await setup('control');
		await button.click();
		const sheet = screen.getByRole('group', { name: 'Session options' });
		const tabs = sheet.getByRole('tab');
		await expect
			.poll(() => tabs.elements().map((tab) => tab.textContent.trim()))
			.toEqual(['Keys', 'Picture', 'Session']);
		await expect
			.element(sheet.getByRole('tab', { name: 'Keys' }))
			.toHaveAttribute('aria-selected', 'true');
		await expect.element(sheet.getByRole('button', { name: 'Show the keyboard' })).toBeVisible();

		await sheet.getByRole('tab', { name: 'Picture' }).click();
		await expect.element(sheet.getByRole('group', { name: 'Quality' })).toBeVisible();

		await sheet.getByRole('tab', { name: 'Session' }).click();
		await expect.element(sheet.getByText('Control', { exact: true })).toBeVisible();
		await expect.element(sheet.getByRole('group', { name: 'Touch input' })).toBeVisible();
		for (const name of ['Switch to view only', 'Leave full screen', 'Disconnect']) {
			await expect.element(sheet.getByRole('button', { name })).toBeVisible();
		}
		await sheet.getByRole('button', { name: 'Leave full screen' }).click();
		expect(onexit).toHaveBeenCalledOnce();
		await expect.element(sheet).not.toBeInTheDocument();

		// The tab chosen last is where the sheet opens again.
		await button.click();
		await expect
			.element(sheet.getByRole('tab', { name: 'Session' }))
			.toHaveAttribute('aria-selected', 'true');
	});

	it('FA5: a Screen tab shows only with more than one display', async () => {
		const { screen, button } = await setup('control', TWO_SCREENS);
		await button.click();
		const sheet = screen.getByRole('group', { name: 'Session options' });
		await sheet.getByRole('tab', { name: 'Screen' }).click();
		await expect.element(sheet.getByRole('button', { name: 'Right' })).toBeVisible();
	});

	it('F6, FA5: a watch-only session opens on Session, with no keys, keyboard or touch input', async () => {
		const { screen, button } = await setup('watch');
		await button.click();
		const sheet = screen.getByRole('group', { name: 'Session options' });
		await expect
			.poll(() =>
				sheet
					.getByRole('tab')
					.elements()
					.map((tab) => tab.textContent.trim())
			)
			.toEqual(['Picture', 'Session']);
		await expect
			.element(sheet.getByRole('tab', { name: 'Session' }))
			.toHaveAttribute('aria-selected', 'true');
		await expect.element(sheet.getByText('View only', { exact: true })).toBeVisible();
		await expect.element(sheet.getByRole('button', { name: 'Take control' })).toBeVisible();
		await expect.element(sheet.getByRole('button', { name: 'Disconnect' })).toBeVisible();
		await expect.element(sheet.getByRole('group', { name: 'Touch input' })).not.toBeInTheDocument();
		for (const name of ['Show the keyboard', /^Alt\+Tab/, 'More']) {
			await expect.element(sheet.getByRole('button', { name })).not.toBeInTheDocument();
		}
	});

	it('FA6: the keys wrap inside the sheet, and its Keys menu sends as the menu does', async () => {
		const { screen, button, sent, backToScreen } = await setup('control');
		await button.click();
		const sheet = screen.getByRole('group', { name: 'Session options' });
		const bar = sheet.getByRole('toolbar', { name: 'Keys' });
		await expect.element(bar).toBeVisible();
		const box = sheet.element().getBoundingClientRect();
		const keys = bar.getByRole('button').elements();
		expect(keys.length).toBeGreaterThan(6);
		for (const key of keys) {
			const at = key.getBoundingClientRect();
			expect(at.left).toBeGreaterThanOrEqual(box.left);
			expect(at.right).toBeLessThanOrEqual(box.right);
		}
		expect(bar.element().scrollWidth).toBeLessThanOrEqual(bar.element().clientWidth);

		await sheet.getByRole('button', { name: /^Alt\+Tab/ }).click();
		expect(sent).toEqual([
			{ type: 'key', code: 'AltLeft', key: 'Alt', down: true, altGr: false },
			{ type: 'key', code: 'Tab', key: 'Tab', down: true, altGr: false },
			{ type: 'key', code: 'Tab', key: 'Tab', down: false, altGr: false },
			{ type: 'key', code: 'AltLeft', key: 'Alt', down: false, altGr: false }
		]);
		expect(backToScreen).toHaveBeenCalled();
	});

	it('FA7: a tab taller than the sheet scrolls inside it, with a fade where there is more', async () => {
		await page.viewport(667, 375);
		const { screen, button } = await setup('control');
		await button.click();
		const sheet = screen.getByRole('group', { name: 'Session options' });
		await sheet.getByRole('button', { name: 'More' }).click();
		const fade = (where: 'top' | 'bottom') => sheet.element().querySelector(`.fade.${where}`);
		await expect.poll(() => fade('bottom')).not.toBeNull();
		expect(fade('top')).toBeNull();

		const scroll = sheet.getByRole('tabpanel').element();
		scroll.scrollTop = scroll.scrollHeight;
		await expect.poll(() => fade('bottom')).toBeNull();
		await expect.poll(() => fade('top')).not.toBeNull();
		// The sheet itself stays inside the screen.
		expect(sheet.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(375);

		// On a taller screen the Session tab fits, so it has no fade.
		await page.viewport(667, 600);
		await sheet.getByRole('tab', { name: 'Session' }).click();
		await expect.poll(() => [fade('top'), fade('bottom')]).toEqual([null, null]);
	});

	it('FA9: Show the keyboard keeps typing on the machine and folds the sheet to the key bar at the top', async () => {
		const { screen, button, sent } = await setup('control');
		await button.click();
		const sheet = screen.getByRole('group', { name: 'Session options' });
		await sheet.getByRole('button', { name: 'Show the keyboard' }).click();
		const typing = screen.getByRole('textbox', { name: 'Type on the machine' });
		await expect.element(typing).toHaveFocus();
		await expect.element(sheet.getByRole('tablist')).not.toBeInTheDocument();
		await expect.element(sheet.getByRole('button', { name: /^Alt\+Tab/ })).not.toBeInTheDocument();
		await expect.element(sheet.getByRole('button', { name: 'Hide the keyboard' })).toBeVisible();
		expect(sheet.element().getBoundingClientRect().top).toBeCloseTo(EDGE, 0);

		await userEvent.keyboard('hi');
		expect(sent.filter((message) => message.type === 'text')).not.toEqual([]);
		await sheet.getByRole('button', { name: 'Escape', exact: true }).click();
		await expect.element(typing).toHaveFocus();
	});
});
