import { createRawSnippet } from 'svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import ShellFrame from './shell-frame.svelte';

const children = createRawSnippet(() => ({ render: () => '<p>Page</p>' }));

const ADMIN: ConsoleUser = {
	id: 'a',
	name: 'Ada Lovelace',
	email: 'ada@example.com',
	role: 'admin'
};
const MEMBER: ConsoleUser = { id: 'm', name: 'Mo Member', email: 'mo@example.com', role: 'member' };

describe('console frame (S14)', () => {
	// The sidebar (where the person is shown on wide screens) appears from 900px.
	beforeEach(async () => {
		await page.viewport(1280, 800);
	});

	it('shows the signed-in person, with a sign-out that posts to /logout', async () => {
		const screen = await render(ShellFrame, {
			user: ADMIN,
			localNetworkMode: false,
			runCommands: false,
			assistant: { kind: 'none' },
			children
		});
		await expect.element(screen.getByText('Ada Lovelace')).toBeInTheDocument();
		await expect.element(screen.getByText('Admin · ada@example.com')).toBeInTheDocument();
		const signOut = screen.getByRole('button', { name: 'Sign out' });
		await expect.element(signOut).toBeInTheDocument();
		const form = signOut.element().closest('form');
		expect(form?.getAttribute('method')).toBe('POST');
		expect(form?.getAttribute('action')).toBe('/logout');
	});

	it('hides the admin pages from members', async () => {
		const screen = await render(ShellFrame, {
			user: MEMBER,
			localNetworkMode: false,
			runCommands: false,
			assistant: { kind: 'none' },
			children
		});
		await expect.element(screen.getByText('Mo Member')).toBeInTheDocument();
		expect(screen.container.querySelector('nav[aria-label="Administration"]')).toBeNull();
		expect(screen.container.textContent).not.toContain('Add machine');
		const admin = await render(ShellFrame, {
			user: ADMIN,
			localNetworkMode: false,
			runCommands: false,
			assistant: { kind: 'none' },
			children
		});
		expect(admin.container.querySelector('nav[aria-label="Administration"]')).not.toBeNull();
	});

	it('L3: shows a thin banner on every page while local network mode is on', async () => {
		const off = await render(ShellFrame, {
			user: MEMBER,
			localNetworkMode: false,
			runCommands: false,
			assistant: { kind: 'none' },
			children
		});
		expect(off.container.textContent).not.toContain('Local network mode');
		await off.unmount();
		const on = await render(ShellFrame, {
			user: MEMBER,
			localNetworkMode: true,
			runCommands: false,
			assistant: { kind: 'none' },
			children
		});
		await expect
			.element(
				on.getByRole('status').filter({ hasText: 'Local network mode: self-signed certificate' })
			)
			.toBeVisible();
	});

	it('M15: while an AI assistant is working as the person, the header names it and links to Account', async () => {
		const none = await render(ShellFrame, {
			user: MEMBER,
			localNetworkMode: false,
			runCommands: false,
			assistant: { kind: 'none' },
			children
		});
		expect(none.container.textContent).not.toContain('is connected as you');
		await none.unmount();
		const connected = await render(ShellFrame, {
			user: MEMBER,
			localNetworkMode: false,
			runCommands: false,
			assistant: { kind: 'connected', name: 'Claude Code' },
			children
		});
		const banner = connected.getByRole('link', { name: 'Claude Code is connected as you' });
		await expect.element(banner).toBeVisible();
		expect(banner.element().getAttribute('href')).toBe('/account');
	});
});
