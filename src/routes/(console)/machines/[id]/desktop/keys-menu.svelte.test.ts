import { describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { InputMessage } from '#lib/domain/desktop/messages.ts';
import type { OsFamily } from '#lib/domain/machines/machine.ts';
import { confirmation } from '#lib/ui/confirm-action.svelte.ts';
import KeysMenu from './keys-menu.svelte';

// SPEC-DESKTOP-KEYS K4, K5.

async function setup(osFamily: OsFamily) {
	const sent: InputMessage[] = [];
	const afterSend = vi.fn();
	const screen = await render(KeysMenu, {
		osFamily,
		send: (message: InputMessage) => {
			sent.push(message);
		},
		afterSend
	});
	return { screen, sent, afterSend };
}

async function openMore(screen: Awaited<ReturnType<typeof setup>>['screen']): Promise<void> {
	await screen.getByRole('button', { name: 'More' }).click();
}

/** The key messages as "+Code" (down) and "-Code" (up). */
function strokes(sent: InputMessage[]): string[] {
	return sent.map((message) =>
		message.type === 'key' ? `${message.down ? '+' : '-'}${message.code}` : message.type
	);
}

describe('the Keys menu', () => {
	it('K4: sends a shortcut as key messages and gives the keyboard back', async () => {
		const { screen, sent, afterSend } = await setup('windows');
		await openMore(screen);
		await screen.getByRole('button', { name: /^Ctrl\+Shift\+Esc/ }).click();
		expect(strokes(sent)).toEqual([
			'+ControlLeft',
			'+ShiftLeft',
			'+Escape',
			'-Escape',
			'-ShiftLeft',
			'-ControlLeft'
		]);
		expect(afterSend).toHaveBeenCalledOnce();
	});

	it('K4: builds a custom combination from toggles and a picked key', async () => {
		const { screen, sent } = await setup('linux');
		await openMore(screen);
		const modifiers = screen.getByRole('group', { name: 'Modifiers' });
		await modifiers.getByRole('button', { name: 'Super' }).click();
		await modifiers.getByRole('button', { name: 'Shift' }).click();
		await expect
			.element(modifiers.getByRole('button', { name: 'Super' }))
			.toHaveAttribute('aria-pressed', 'true');
		await screen.getByRole('button', { name: 'F1–F12' }).click();
		await screen.getByRole('button', { name: 'F5', exact: true }).click();
		await screen.getByRole('button', { name: 'Send Shift+Super+F5' }).click();
		expect(strokes(sent)).toEqual([
			'+ShiftLeft',
			'+MetaLeft',
			'+F5',
			'-F5',
			'-MetaLeft',
			'-ShiftLeft'
		]);
	});

	it('K4: Press a key takes the next key and the modifiers held with it', async () => {
		const { screen, sent } = await setup('windows');
		await openMore(screen);
		const capture = screen.getByRole('button', { name: /^Press a key/ });
		await capture.click();
		await expect.element(capture).toHaveTextContent('Press a key now…');
		await userEvent.keyboard('{Control>}{Alt>}t{/Alt}{/Control}');
		await screen.getByRole('button', { name: 'Send Ctrl+Alt+T' }).click();
		expect(strokes(sent)).toEqual([
			'+ControlLeft',
			'+AltLeft',
			'+KeyT',
			'-KeyT',
			'-AltLeft',
			'-ControlLeft'
		]);
	});

	it('K4: Release all keys sends release-all', async () => {
		const { screen, sent } = await setup('windows');
		await openMore(screen);
		await screen.getByRole('button', { name: 'Release all keys' }).click();
		expect(sent).toEqual([{ type: 'release-all' }]);
	});

	it('K5: Ctrl+Alt+Del on Windows sends the special key without asking', async () => {
		const { screen, sent } = await setup('windows');
		await screen.getByRole('button', { name: /^Ctrl\+Alt\+Del/ }).click();
		expect(confirmation.current.kind).toBe('none');
		expect(sent).toEqual([{ type: 'special', name: 'ctrl-alt-del' }]);
	});

	it('K5: Ctrl+Alt+Del on Linux asks first, and sends nothing when cancelled', async () => {
		const { screen, sent, afterSend } = await setup('linux');
		const button = screen.getByRole('button', { name: /^Ctrl\+Alt\+Del/ });
		await button.click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		if (confirmation.current.kind === 'asking') {
			expect(confirmation.current.options.message).toContain('restart');
			confirmation.current.answer(false);
		}
		await new Promise((done) => setTimeout(done, 20));
		expect(sent).toEqual([]);
		expect(afterSend).not.toHaveBeenCalled();

		await button.click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		if (confirmation.current.kind === 'asking') confirmation.current.answer(true);
		await expect.poll(() => sent).toEqual([{ type: 'special', name: 'ctrl-alt-del' }]);
	});

	it('K8: the everyday shortcuts are on view; the rest, the custom combination and Release all wait under More', async () => {
		const { screen } = await setup('windows');
		for (const name of [/^Ctrl\+Alt\+Del/, /^Win, /, /^Alt\+Tab/, /^Alt\+F4/, /^Win\+L/]) {
			await expect.element(screen.getByRole('button', { name })).toBeVisible();
		}
		// The hint is a tooltip and part of the name, not text on the pill.
		expect(
			screen
				.getByRole('button', { name: /^Ctrl\+Alt\+Del/ })
				.element()
				.textContent.trim()
		).toBe('Ctrl+Alt+Del');
		await expect
			.element(screen.getByRole('button', { name: /^Ctrl\+Shift\+Esc/ }))
			.not.toBeInTheDocument();
		await expect.element(screen.getByText('Custom combination')).not.toBeInTheDocument();
		const more = screen.getByRole('button', { name: 'More' });
		await expect.element(more).toHaveAttribute('aria-expanded', 'false');
		await more.click();
		await expect.element(screen.getByRole('button', { name: /^Ctrl\+Shift\+Esc/ })).toBeVisible();
		await expect.element(screen.getByText('Custom combination')).toBeVisible();
		await screen.getByRole('button', { name: 'Fewer' }).click();
		await expect.element(screen.getByText('Custom combination')).not.toBeInTheDocument();
	});

	it('K8: at phone width the everyday row takes at most two lines', async () => {
		await page.viewport(375, 700);
		const { screen } = await setup('windows');
		const row = screen.getByRole('group', { name: 'Keys' }).element();
		expect(row.getBoundingClientRect().height).toBeLessThanOrEqual(2 * 40 + 8 + 1);
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
	});

	it('K2: macOS offers no Ctrl+Alt+Del', async () => {
		const { screen } = await setup('macos');
		await expect.element(screen.getByRole('button', { name: /^Cmd\+Tab/ })).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: /^Ctrl\+Alt\+Del/ }))
			.not.toBeInTheDocument();
	});
});
