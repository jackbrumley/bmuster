import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import '#lib/ui/design-tokens.css';
import LiveStatus from './live-status.svelte';

// SPEC-DESKTOP-FLOATING FB1, FB12: the live figures stack and keep a fixed width, beside the link's dot.

describe('the live status', () => {
	it('FB1: the figures keep one width as they change, in figures of one width', async () => {
		const screen = await render(LiveStatus, {
			status: { kind: 'figures', fps: 9, kilobytes: 5, health: 'good' }
		});
		const status = screen.getByRole('status');
		await expect.element(status).toHaveTextContent('9 fps 5 KB/s');
		const narrow = status.element().getBoundingClientRect().width;
		await screen.rerender({
			status: { kind: 'figures', fps: 30, kilobytes: 12345, health: 'good' }
		});
		await expect.element(status).toHaveTextContent('30 fps 12345 KB/s');
		expect(status.element().getBoundingClientRect().width).toBe(narrow);
		expect(getComputedStyle(status.element()).fontVariantNumeric).toBe('tabular-nums');
	});

	it('FB1: the frame rate sits above the speed, in two short lines', async () => {
		const screen = await render(LiveStatus, {
			status: { kind: 'figures', fps: 30, kilobytes: 12345, health: 'good' }
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

	it('FB12: a dot beside the figures shows the link in colour, and says it in words', async () => {
		const screen = await render(LiveStatus, {
			status: { kind: 'figures', fps: 30, kilobytes: 120, health: 'good' }
		});
		const colours = {
			good: '--success',
			slow: '--warning',
			struggling: '--danger'
		} as const;
		for (const health of ['good', 'slow', 'struggling'] as const) {
			await screen.rerender({ status: { kind: 'figures', fps: 30, kilobytes: 120, health } });
			const dot = screen.getByRole('img', { name: `Connection: ${health}` });
			await expect.element(dot).toBeVisible();
			expect(dot.element().getAttribute('title')).toBe(`Connection: ${health}`);
			const probe = document.createElement('span');
			probe.style.backgroundColor = `var(${colours[health]})`;
			document.body.append(probe);
			expect(getComputedStyle(dot.element()).backgroundColor).toBe(
				getComputedStyle(probe).backgroundColor
			);
			probe.remove();
		}
	});

	it('FB1: words show as they are', async () => {
		const screen = await render(LiveStatus, { status: { kind: 'text', text: 'Reconnecting…' } });
		await expect.element(screen.getByRole('status')).toHaveTextContent('Reconnecting…');
	});
});
