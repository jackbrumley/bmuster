import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '#lib/ui/design-tokens.css';
import LiveStatus from './live-status.svelte';

// SPEC-DESKTOP-FLOATING FB1: the live figures stack, and keep a fixed width.

describe('the live status', () => {
	it('FB1: the figures keep one width as they change, in figures of one width', async () => {
		const screen = await render(LiveStatus, {
			status: { kind: 'figures', fps: 9, kilobytes: 5 }
		});
		const status = screen.getByRole('status');
		await expect.element(status).toHaveTextContent('9 fps 5 KB/s');
		const narrow = status.element().getBoundingClientRect().width;
		await screen.rerender({ status: { kind: 'figures', fps: 30, kilobytes: 12345 } });
		await expect.element(status).toHaveTextContent('30 fps 12345 KB/s');
		expect(status.element().getBoundingClientRect().width).toBe(narrow);
		expect(getComputedStyle(status.element()).fontVariantNumeric).toBe('tabular-nums');
	});

	it('FB1: the frame rate sits above the speed, in two short lines', async () => {
		const screen = await render(LiveStatus, {
			status: { kind: 'figures', fps: 30, kilobytes: 12345 }
		});
		const status = screen.getByRole('status');
		await expect.element(status).toBeVisible();
		const [fps, speed] = [...status.element().querySelectorAll('.figure')].map((figure) =>
			figure.getBoundingClientRect()
		);
		if (fps === undefined || speed === undefined) {
			throw new Error('Expected the two figures.');
		}
		// One above the other, sharing the column, not side by side.
		expect(speed.top).toBeGreaterThanOrEqual(fps.bottom - 1);
		expect(speed.right).toBeCloseTo(fps.right, 0);
		// Two lines of small type: no taller than a 40px tool button.
		expect(status.element().getBoundingClientRect().height).toBeLessThanOrEqual(32);
	});

	it('FB1: words show as they are', async () => {
		const screen = await render(LiveStatus, { status: { kind: 'text', text: 'Reconnecting…' } });
		await expect.element(screen.getByRole('status')).toHaveTextContent('Reconnecting…');
	});
});
