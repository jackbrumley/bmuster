import { createRawSnippet } from 'svelte';
import { beforeEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { emptyCounts, type RunSummary } from '#lib/domain/commands/commands.ts';
import ShellFrame from '#lib/shell/shell-frame.svelte';
import CommandsPage from './+page.svelte';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const MEMBER = { id: 'm', name: 'Pat', email: 'pat@example.com', role: 'member' } as const;

function summary(id: string, startedIso: string, firstLine: string): RunSummary {
	return {
		id,
		startedBy: 'Ada Lovelace',
		startedIso,
		status: 'finished',
		commands: [{ osFamily: 'windows', firstLine }],
		counts: { ...emptyCounts(), succeeded: 19, failed: 1, offline: 1 }
	};
}

const NEWER = summary(
	'22222222-2222-4222-8222-222222222222',
	'2026-11-14T11:00:00.000Z',
	'Restart-Service Spooler'
);
const OLDER = summary(
	'11111111-1111-4111-8111-111111111111',
	'2026-11-12T12:00:00.000Z',
	'Get-Service'
);

beforeEach(async () => {
	await page.viewport(1280, 800);
});

describe('the Commands tab (SPEC-COMMANDS C20)', () => {
	it('C20: lists runs newest first with who, when, the first line and the counts; each opens its results', async () => {
		const screen = await render(CommandsPage, {
			params: {},
			form: undefined,
			data: {
				user: MEMBER,
				localNetworkMode: false,
				serverUpdate: null,
				runCommands: true,
				assistant: { kind: 'none' },
				signedIn: true,
				now: NOW,
				runs: [NEWER, OLDER]
			}
		});
		const links = screen
			.getByRole('list', { name: 'Command runs, newest first' })
			.getByRole('link');
		await expect.element(links.first()).toBeVisible();
		const first = links.first().element().textContent;
		expect(first).toContain('Restart-Service Spooler');
		expect(first).toContain('Ada Lovelace');
		expect(first).toContain('19 succeeded · 1 failed · 1 offline');
		await expect.element(links.first()).toHaveAttribute('href', `/commands/${NEWER.id}`);
		expect(links.nth(1).element().textContent).toContain('Get-Service');
	});

	it('C20: the tab shows only for people who may run commands somewhere', async () => {
		const children = createRawSnippet(() => ({ render: () => '<p>Page</p>' }));
		const allowed = await render(ShellFrame, {
			user: MEMBER,
			localNetworkMode: false,
			runCommands: true,
			assistant: { kind: 'none' },
			children
		});
		await expect
			.element(
				allowed
					.getByRole('navigation', { name: 'Main' })
					.first()
					.getByRole('link', { name: 'Commands' })
			)
			.toBeVisible();
		await allowed.unmount();
		const without = await render(ShellFrame, {
			user: MEMBER,
			localNetworkMode: false,
			runCommands: false,
			assistant: { kind: 'none' },
			children
		});
		await expect.element(without.getByText('Page')).toBeVisible();
		expect(without.getByRole('link', { name: 'Commands' }).query()).toBeNull();
	});
});
