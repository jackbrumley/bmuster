import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { AgentDownload } from '#lib/domain/machines/agent-release.ts';
import AddMachine from './add-machine.svelte';

const ORIGIN = 'https://bmuster.example';
const SHA = 'ab'.repeat(32);

const DOWNLOADS: AgentDownload[] = [
	{
		kind: 'ready',
		target: 'x86_64-unknown-linux-gnu',
		version: '0.1.0',
		size: 3 * 1024 * 1024,
		sha256: SHA
	},
	{ kind: 'none', target: 'aarch64-unknown-linux-gnu' },
	{
		kind: 'ready',
		target: 'x86_64-pc-windows-msvc',
		version: '0.1.0',
		size: 4 * 1024 * 1024,
		sha256: 'cd'.repeat(32)
	}
];

/** Answers POST /api/join-codes like the server, and records each request body. */
function stubJoinCodes(): { bodies: unknown[] } {
	const bodies: unknown[] = [];
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			if (url !== '/api/join-codes' || typeof init.body !== 'string') {
				throw new Error(`unexpected request to ${url}`);
			}
			const body: unknown = JSON.parse(init.body);
			bodies.push(body);
			const maxUses =
				typeof body === 'object' && body !== null && 'maxUses' in body ? body.maxUses : 1;
			return Promise.resolve(
				Response.json({
					code: maxUses === 1 ? 'ABC-DEF-GHJ' : 'RLL-OUT-234',
					expiresAtIso: '2026-11-08T10:00:00.000Z',
					maxUses
				})
			);
		})
	);
	return { bodies };
}

async function renderPage(downloads: AgentDownload[], devServer: boolean) {
	return render(AddMachine, { origin: ORIGIN, downloads, devServer });
}

function manualSection(container: HTMLElement): HTMLDetailsElement {
	const details = container.querySelector('details');
	if (!(details instanceof HTMLDetailsElement)) throw new Error('no Install manually section');
	return details;
}

describe('Add machine: install manually', () => {
	it('M1: a collapsed Install manually section under the command, on every OS tab', async () => {
		const screen = await renderPage(DOWNLOADS, false);
		for (const os of ['Linux', 'Windows', 'macOS']) {
			await screen.getByRole('button', { name: os }).click();
			await expect.element(screen.getByText('Install manually')).toBeVisible();
			expect(manualSection(screen.container).open, os).toBe(false);
		}
		await screen.getByText('Install manually').click();
		await expect
			.element(screen.getByText('The macOS agent is not built yet.').last())
			.toBeVisible();
	});

	it('M2: Download agent for the chosen OS, with version, size and SHA-256', async () => {
		const screen = await renderPage(DOWNLOADS, false);
		await screen.getByText('Install manually').click();
		const link = screen.getByRole('link', { name: 'Download agent' });
		await expect
			.element(link)
			.toHaveAttribute('href', '/agent/v1/releases/0.1.0/x86_64-unknown-linux-gnu');
		await expect
			.element(screen.getByText('Version 0.1.0 for x86_64-unknown-linux-gnu · 3.0 MB'))
			.toBeVisible();
		await expect.element(screen.getByText(SHA)).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Copy SHA-256' })).toBeVisible();

		await screen.getByRole('button', { name: 'Windows' }).click();
		await expect
			.element(screen.getByRole('link', { name: 'Download agent' }))
			.toHaveAttribute('href', '/agent/v1/releases/0.1.0/x86_64-pc-windows-msvc');
		await expect.element(screen.getByText('cd'.repeat(32))).toBeVisible();
	});

	it('M2: says plainly when the server has no build (and, in dev, how to make one)', async () => {
		const screen = await renderPage(DOWNLOADS, true);
		await screen.getByText('Install manually').click();
		await screen.getByRole('button', { name: 'aarch64 (ARM)' }).click();
		await expect
			.element(
				screen.getByText('This server has no agent build for aarch64-unknown-linux-gnu yet.')
			)
			.toBeVisible();
		await expect.element(screen.getByText('npm run agent:release-local')).toBeVisible();
		expect(screen.container.querySelector('a[download]')).toBeNull();

		await screen.unmount();
		const production = await renderPage([], false);
		await production.getByText('Install manually').click();
		await expect
			.element(
				production.getByText('This server has no agent build for x86_64-unknown-linux-gnu yet.')
			)
			.toBeVisible();
		expect(production.container.textContent).not.toContain('agent:release-local');
	});

	it('M3: the command beside the file, with the server and join code, once a code exists', async () => {
		stubJoinCodes();
		const screen = await renderPage(DOWNLOADS, false);
		await screen.getByText('Install manually').click();
		await expect
			.element(screen.getByText('Make a join code above to see the command.'))
			.toBeVisible();

		await screen.getByRole('button', { name: 'Make a join code' }).click();
		await expect
			.element(
				screen.getByText(
					`chmod +x bmuster-agent && sudo ./bmuster-agent install --url ${ORIGIN} --code ABC-DEF-GHJ`
				)
			)
			.toBeVisible();

		await screen.getByRole('button', { name: 'Windows' }).click();
		await expect
			.element(
				screen.getByText('Then, in PowerShell as Administrator, in the folder with the file')
			)
			.toBeVisible();
		await expect
			.element(screen.getByText(`.\\bmuster-agent.exe install --url ${ORIGIN} --code ABC-DEF-GHJ`))
			.toBeVisible();
	});

	it('M4: a deployment tools note, and a control that makes a roll-out code', async () => {
		const { bodies } = stubJoinCodes();
		const screen = await renderPage(DOWNLOADS, false);
		await screen.getByText('Install manually').click();
		await expect.element(screen.getByText('For deployment tools')).toBeVisible();
		await expect
			.element(screen.getByText(/up to 100 machines,\s+for\s+up\s+to 7 days/))
			.toBeVisible();

		await screen.getByRole('button', { name: '100' }).click();
		await screen.getByRole('button', { name: '7 days' }).click();
		await screen.getByRole('button', { name: 'Make a roll-out code' }).click();
		await expect.element(screen.getByText('RLL-OUT-234')).toBeVisible();
		expect(bodies).toEqual([{ maxUses: 100, minutes: 10080 }]);
		await expect
			.element(
				screen.getByText(
					`chmod +x bmuster-agent && sudo ./bmuster-agent install --url ${ORIGIN} --code RLL-OUT-234`
				)
			)
			.toBeVisible();
	});
});
