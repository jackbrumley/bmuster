import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '#lib/ui/design-tokens.css';
import LiveStatus from './live-status.svelte';

// SPEC-DESKTOP-FLOATING FB1: the live figures keep a fixed width.

describe('the live status', () => {
	it('FB1: the figures keep one width as they change, in figures of one width', async () => {
		const screen = await render(LiveStatus, {
			status: { kind: 'figures', fps: 9, kilobytes: 5 }
		});
		const status = screen.getByRole('status');
		await expect.element(status).toHaveTextContent('9 fps · 5 KB/s');
		const narrow = status.element().getBoundingClientRect().width;
		await screen.rerender({ status: { kind: 'figures', fps: 30, kilobytes: 12345 } });
		await expect.element(status).toHaveTextContent('30 fps · 12345 KB/s');
		expect(status.element().getBoundingClientRect().width).toBe(narrow);
		expect(getComputedStyle(status.element()).fontVariantNumeric).toBe('tabular-nums');
	});

	it('FB1: words show as they are', async () => {
		const screen = await render(LiveStatus, { status: { kind: 'text', text: 'Reconnecting…' } });
		await expect.element(screen.getByRole('status')).toHaveTextContent('Reconnecting…');
	});
});
