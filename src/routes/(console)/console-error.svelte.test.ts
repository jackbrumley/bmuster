import { beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import ShellFrame from '#lib/shell/shell-frame.svelte';
import ConsoleError from './console-error.svelte';

const MEMBER = { id: 'm', name: 'Mo Member', email: 'mo@example.com', role: 'member' as const };

function props(
	status: number,
	place: 'page' | 'machine',
	header: 'page' | 'machine',
	message = ''
) {
	return { status, message, reference: undefined, place, header };
}

describe('console error (SPEC-ERROR-PAGES E2, E3)', () => {
	beforeEach(async () => {
		await page.viewport(1280, 800);
	});

	it('E2: shows inside the console frame, with the sidebar still there', async () => {
		const shell = await render(ConsoleError, props(404, 'page', 'page'), {
			wrapper: ShellFrame,
			wrapperProps: {
				user: MEMBER,
				localNetworkMode: false,
				runCommands: false,
				assistant: { kind: 'none' },
				approvals: { kind: 'hidden' }
			}
		});
		await expect.element(shell.getByText('Mo Member')).toBeInTheDocument();
		const heading = shell.getByRole('heading', { level: 1, name: 'Page not found' });
		await expect.element(heading).toBeVisible();
		expect(heading.element().closest('main')).not.toBeNull();
		await expect.element(shell.getByRole('button', { name: 'Go to Machines' })).toBeVisible();
	});

	it('E2: a missing or hidden machine says both, without the raw message', async () => {
		const screen = await render(
			ConsoleError,
			props(404, 'machine', 'page', 'No machine with this id')
		);
		await expect
			.element(screen.getByRole('heading', { level: 1, name: 'Machine not found' }))
			.toBeVisible();
		await expect
			.element(screen.getByText('It may have been removed, or you may not have access.'))
			.toBeVisible();
		expect(screen.container.textContent).not.toContain('No machine with this id');
		expect(screen.container.textContent).not.toContain('Try again');
	});

	it('E3: under a machine header, puts the title in the panel instead of a page header', async () => {
		const screen = await render(
			ConsoleError,
			props(403, 'machine', 'machine', 'Only admins can open this page.')
		);
		expect(screen.container.querySelector('h1')).toBeNull();
		await expect
			.element(screen.getByRole('heading', { level: 2, name: 'Not allowed' }))
			.toBeVisible();
		await expect.element(screen.getByText('Only admins can open this page.')).toBeVisible();
		await expect.element(screen.getByText('Error 403')).toBeVisible();
	});

	it('offers "Try again" for a server error', async () => {
		const screen = await render(ConsoleError, props(500, 'page', 'page'));
		await expect
			.element(screen.getByRole('heading', { level: 1, name: 'Something went wrong' }))
			.toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
	});
});
