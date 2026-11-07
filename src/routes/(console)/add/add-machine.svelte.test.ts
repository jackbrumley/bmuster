import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { AgentDownload } from '#lib/domain/machines/agent-release.ts';
import type { LocalTlsStatus } from '#lib/domain/settings/local-tls.ts';
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

const PUBLIC_TLS: LocalTlsStatus = { on: false, restartNeeded: false, served: { kind: 'none' } };
const PIN = `sha256:${'A'.repeat(43)}=`;
const FINGERPRINT = Array.from({ length: 32 }, () => 'AB').join(':');
const LOCAL_TLS: LocalTlsStatus = {
	on: true,
	restartNeeded: false,
	served: { kind: 'pin', pin: PIN, fingerprint: FINGERPRINT }
};

async function renderPage(
	downloads: AgentDownload[],
	devServer: boolean,
	localTls: LocalTlsStatus = PUBLIC_TLS
) {
	return render(AddMachine, { origin: ORIGIN, downloads, devServer, localTls });
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

	it('M3: the command beside the file, with the server and a join code made when the page opens', async () => {
		stubJoinCodes();
		const screen = await renderPage(DOWNLOADS, false);
		await screen.getByText('Install manually').click();
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
		// The first request is the code made when the page opens; the second is the roll-out code.
		expect(bodies).toEqual([
			{ maxUses: 1, minutes: 60 },
			{ maxUses: 100, minutes: 10080 }
		]);
		await expect
			.element(
				screen.getByText(
					`chmod +x bmuster-agent && sudo ./bmuster-agent install --url ${ORIGIN} --code RLL-OUT-234`
				)
			)
			.toBeVisible();
	});
});

describe('Add machine: local network mode', () => {
	it('L5: shows the pin and the browser fingerprint, and every command carries the pin', async () => {
		const { bodies } = stubJoinCodes();
		const screen = await renderPage(DOWNLOADS, false, LOCAL_TLS);
		await expect.element(screen.getByText(PIN, { exact: true }).first()).toBeVisible();
		await expect.element(screen.getByText(FINGERPRINT)).toBeVisible();
		await expect
			.element(screen.getByText(/against your browser's certificate details/))
			.toBeVisible();

		// L6: the download itself is pinned (curl --pinnedpubkey), and the agent gets --pin-cert.
		await expect
			.element(
				screen.getByText(
					`curl -fsSL --pinnedpubkey 'sha256//${'A'.repeat(43)}=' -k ${ORIGIN}/install.sh | sudo sh -s -- --code ABC-DEF-GHJ --pin-cert ${PIN}`
				)
			)
			.toBeVisible();
		await screen.getByText('Install manually').click();
		await expect
			.element(
				screen.getByText(
					`chmod +x bmuster-agent && sudo ./bmuster-agent install --url ${ORIGIN} --code ABC-DEF-GHJ --pin-cert ${PIN}`
				)
			)
			.toBeVisible();

		await screen.getByRole('button', { name: 'Windows' }).click();
		await expect
			.element(
				screen.getByText(
					`& ([scriptblock]::Create((curl.exe -fsSL --pinnedpubkey 'sha256//${'A'.repeat(43)}=' -k ${ORIGIN}/install.ps1) -join "\`n")) -Code ABC-DEF-GHJ -PinCert '${PIN}'`
				)
			)
			.toBeVisible();
		await expect
			.element(
				screen.getByText(
					`.\\bmuster-agent.exe install --url ${ORIGIN} --code ABC-DEF-GHJ --pin-cert '${PIN}'`
				)
			)
			.toBeVisible();
		await screen.getByRole('button', { name: 'Make a roll-out code' }).click();
		await expect
			.element(
				screen.getByText(
					`.\\bmuster-agent.exe install --url ${ORIGIN} --code RLL-OUT-234 --pin-cert '${PIN}'`
				)
			)
			.toBeVisible();
		expect(bodies).toHaveLength(2);
	});

	it('L5: without local network mode no command carries a pin', async () => {
		stubJoinCodes();
		const screen = await renderPage(DOWNLOADS, false);
		await expect
			.element(
				screen.getByText(`curl -fsSL ${ORIGIN}/install.sh | sudo sh -s -- --code ABC-DEF-GHJ`)
			)
			.toBeVisible();
		expect(screen.container.textContent).not.toContain('--pin-cert');
	});

	it('L4: says to restart when the mode is on but the server is not serving its certificate yet', async () => {
		stubJoinCodes();
		const screen = await renderPage(DOWNLOADS, false, {
			on: true,
			restartNeeded: true,
			served: { kind: 'none' }
		});
		await expect.element(screen.getByText(/Restart\s+BMuster to apply it/)).toBeVisible();
		await expect
			.element(
				screen.getByText(`curl -fsSL ${ORIGIN}/install.sh | sudo sh -s -- --code ABC-DEF-GHJ`)
			)
			.toBeVisible();
	});
});
