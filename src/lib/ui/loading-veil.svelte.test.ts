import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { createRawSnippet } from 'svelte';
import LoadingVeil from './loading-veil.svelte';

const covered = createRawSnippet(() => ({ render: () => '<p>The covered panel</p>' }));

function busyBlock(container: HTMLElement): Element {
	const block = container.querySelector('[aria-busy]');
	if (block === null) throw new Error('no veiled block');
	return block;
}

describe('LoadingVeil (SPEC-LOADING L2)', () => {
	it('L2: appears only after 150 ms, with its title and detail as a polite status', async () => {
		const screen = await render(LoadingVeil, {
			active: true,
			title: 'Updating BMuster to 0.4.5',
			detail: 'Waiting for the server to come back',
			children: covered
		});
		const status = screen.getByRole('status');
		// Within the first 150 ms nothing shows, so a quick load never flashes.
		await expect.element(status).not.toBeInTheDocument();
		await expect.element(status).toBeVisible();
		await expect.element(status.getByText('Updating BMuster to 0.4.5')).toBeVisible();
		await expect.element(status.getByText('Waiting for the server to come back')).toBeVisible();
		expect(status.element().getAttribute('aria-live')).toBe('polite');
		expect(busyBlock(screen.container).getAttribute('aria-busy')).toBe('true');
		// The block underneath stays in place and cannot be used while it loads.
		const panel = screen.getByText('The covered panel');
		await expect.element(panel).toBeInTheDocument();
		expect(panel.element().closest('[inert]')).not.toBeNull();
	});

	it('L2: shows no detail line when there is none', async () => {
		const screen = await render(LoadingVeil, {
			active: true,
			title: 'Reading the drives',
			detail: undefined,
			children: undefined
		});
		const status = screen.getByRole('status');
		await expect.element(status).toBeVisible();
		expect(status.element().querySelectorAll('p')).toHaveLength(1);
	});

	it('L2: leaves when inactive, and the block is no longer busy', async () => {
		const screen = await render(LoadingVeil, {
			active: true,
			title: 'Reading the checks',
			detail: undefined,
			children: covered
		});
		await expect.element(screen.getByRole('status')).toBeVisible();
		await screen.rerender({ active: false });
		await expect.element(screen.getByRole('status')).not.toBeInTheDocument();
		expect(busyBlock(screen.container).getAttribute('aria-busy')).toBe('false');
		expect(screen.getByText('The covered panel').element().closest('[inert]')).toBeNull();
	});

	it('L2: a load that ends within 150 ms never shows', async () => {
		const screen = await render(LoadingVeil, {
			active: true,
			title: 'Reading the checks',
			detail: undefined,
			children: covered
		});
		await screen.rerender({ active: false });
		await new Promise((resolve) => setTimeout(resolve, 300));
		await expect.element(screen.getByText('Reading the checks')).not.toBeInTheDocument();
	});
});
