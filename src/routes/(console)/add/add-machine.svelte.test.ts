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

const SINGLE_ID = '11111111-1111-4111-8111-111111111111';
const ROLLOUT_ID = '22222222-2222-4222-8222-222222222222';

type StubStatus = {
	maxUses: number;
	uses: number;
	expiresAtIso: string;
	state: 'open' | 'used-up' | 'expired';
	machines: { id: string; name: string; enrolledAtIso: string; removed: boolean }[];
};

const OPEN: StubStatus = {
	maxUses: 1,
	uses: 0,
	expiresAtIso: '2026-11-08T10:00:00.000Z',
	state: 'open',
	machines: []
};

/**
 * Answers POST /api/join-codes and GET /api/join-codes/<id> like the server.
 * Records each POST body and counts the status requests; `statuses` says what
 * each code's status is now, and a test changes it to show a machine joining.
 */
function stubJoinCodes(): {
	bodies: unknown[];
	statusRequests: () => number;
	statuses: Map<string, StubStatus>;
} {
	const bodies: unknown[] = [];
	let statusRequests = 0;
	const statuses = new Map<string, StubStatus>([
		[SINGLE_ID, OPEN],
		[ROLLOUT_ID, { ...OPEN, maxUses: 100 }]
	]);
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			if (url.startsWith('/api/join-codes/') && init.method === 'GET') {
				statusRequests += 1;
				const status = statuses.get(url.slice('/api/join-codes/'.length));
				if (status === undefined) throw new Error(`unknown code in ${url}`);
				return Promise.resolve(Response.json(status));
			}
			if (url !== '/api/join-codes' || typeof init.body !== 'string') {
				throw new Error(`unexpected request to ${url}`);
			}
			const body: unknown = JSON.parse(init.body);
			bodies.push(body);
			const maxUses =
				typeof body === 'object' && body !== null && 'maxUses' in body ? body.maxUses : 1;
			return Promise.resolve(
				Response.json({
					id: maxUses === 1 ? SINGLE_ID : ROLLOUT_ID,
					code: maxUses === 1 ? 'ABC-DEF-GHJ' : 'RLL-OUT-234',
					expiresAtIso: '2026-11-08T10:00:00.000Z',
					maxUses
				})
			);
		})
	);
	return { bodies, statusRequests: () => statusRequests, statuses };
}

const PUBLIC_TLS: LocalTlsStatus = { on: false, restartNeeded: false, served: { kind: 'none' } };
const PIN = `sha256:${'A'.repeat(43)}=`;
const FINGERPRINT = Array.from({ length: 32 }, () => 'AB').join(':');
const LOCAL_TLS: LocalTlsStatus = {
	on: true,
	restartNeeded: false,
	served: { kind: 'pin', pin: PIN, fingerprint: FINGERPRINT }
};

const OFFICE = '33333333-3333-4333-8333-333333333333';
const LAB = '44444444-4444-4444-8444-444444444444';
const MACHINE_GROUPS = [
	{ id: OFFICE, name: 'Office' },
	{ id: LAB, name: 'Lab' }
];

async function renderPage(
	downloads: AgentDownload[],
	devServer: boolean,
	localTls: LocalTlsStatus = PUBLIC_TLS
) {
	return render(AddMachine, {
		origin: ORIGIN,
		downloads,
		devServer,
		localTls,
		machineGroups: MACHINE_GROUPS
	});
}

function manualSection(container: HTMLElement): HTMLDetailsElement {
	const details = container.querySelector('details');
	if (!(details instanceof HTMLDetailsElement)) throw new Error('no agent download section');
	return details;
}

describe('Add machine: install manually', () => {
	it('presents Quick join before the secondary manual install method', async () => {
		const screen = await renderPage(DOWNLOADS, false);
		const headings = [...screen.container.querySelectorAll('h2')].map(
			(heading) => heading.textContent
		);
		expect(headings.indexOf('Quick join')).toBeGreaterThanOrEqual(0);
		expect(headings.indexOf('Quick join')).toBeLessThan(headings.indexOf('Manual install'));
		await expect
			.element(screen.getByText(/With the person at their computer or helping from elsewhere/))
			.toBeVisible();
	});

	it('M1: a collapsed agent-download section for every selected OS', async () => {
		const screen = await renderPage(DOWNLOADS, false);
		for (const os of ['Linux', 'Windows', 'macOS']) {
			await screen.getByRole('button', { name: os }).click();
			await expect.element(screen.getByText('Download the agent file')).toBeVisible();
			expect(manualSection(screen.container).open, os).toBe(false);
		}
		await screen.getByText('Download the agent file').click();
		await expect
			.element(screen.getByText('The macOS agent is not built yet.').last())
			.toBeVisible();
	});

	it('requires an explicit OS choice before showing any install command', async () => {
		stubJoinCodes();
		const screen = await renderPage(DOWNLOADS, false);
		await expect
			.element(
				screen.getByText("Choose the computer's operating system to see its install options.")
			)
			.toBeVisible();
		for (const name of ['Linux', 'Windows', 'macOS']) {
			await expect
				.element(screen.getByRole('button', { name }))
				.toHaveAttribute('aria-pressed', 'false');
		}
		expect(screen.container.textContent).not.toContain('Run in a terminal');
		expect(screen.container.textContent).not.toContain('Run in PowerShell as administrator');
		expect(screen.container.querySelector('details')).toBeNull();
		await screen.getByRole('button', { name: 'Windows' }).click();
		await expect.element(screen.getByText('Run in PowerShell as administrator')).toBeVisible();
	});

	it('M2: Download agent for the chosen OS, with version, size and SHA-256', async () => {
		const screen = await renderPage(DOWNLOADS, false);
		await screen.getByRole('button', { name: 'Linux' }).click();
		await screen.getByText('Download the agent file').click();
		await screen.getByRole('button', { name: 'x86_64 (Intel, AMD)' }).click();
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
		await screen.getByRole('button', { name: 'Linux' }).click();
		await screen.getByText('Download the agent file').click();
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
		await production.getByRole('button', { name: 'Linux' }).click();
		await production.getByText('Download the agent file').click();
		await production.getByRole('button', { name: 'x86_64 (Intel, AMD)' }).click();
		await expect
			.element(
				production.getByText('This server has no agent build for x86_64-unknown-linux-gnu yet.')
			)
			.toBeVisible();
		expect(production.container.textContent).not.toContain('agent:release-local');
	});

	it('M1: offers no one-line command for an OS the server has no agent build for', async () => {
		stubJoinCodes();
		const linuxOnly = DOWNLOADS.filter((download) => download.target !== 'x86_64-pc-windows-msvc');
		const screen = await renderPage(linuxOnly, false);
		expect(screen.container.textContent).not.toContain('Run in a terminal');
		await screen.getByRole('button', { name: 'Linux' }).click();
		await expect.element(screen.getByText('Run in a terminal')).toBeVisible();
		await screen.getByRole('button', { name: 'Windows' }).click();
		await expect.element(screen.getByText(/This server has no Windows agent yet/)).toBeVisible();
		expect(screen.container.textContent).not.toContain('Run in PowerShell as administrator');
	});

	it('M2: no processor is chosen for Linux until the admin picks one', async () => {
		const screen = await renderPage(DOWNLOADS, false);
		await screen.getByRole('button', { name: 'Linux' }).click();
		await screen.getByText('Download the agent file').click();
		await expect
			.element(screen.getByText("Choose the machine's processor to see its download."))
			.toBeVisible();
		for (const name of ['x86_64 (Intel, AMD)', 'aarch64 (ARM)']) {
			await expect
				.element(screen.getByRole('button', { name }))
				.toHaveAttribute('aria-pressed', 'false');
		}
		expect(screen.container.querySelector('a[download]')).toBeNull();
		expect(screen.container.textContent).not.toContain(SHA);

		await screen.getByRole('button', { name: 'aarch64 (ARM)' }).click();
		await expect
			.element(screen.getByRole('button', { name: 'aarch64 (ARM)' }))
			.toHaveAttribute('aria-pressed', 'true');
		await expect
			.element(
				screen.getByText('This server has no agent build for aarch64-unknown-linux-gnu yet.')
			)
			.toBeVisible();
	});

	it('M2: Windows has one build, so its download shows straight away', async () => {
		const screen = await renderPage(DOWNLOADS, false);
		await screen.getByRole('button', { name: 'Linux' }).click();
		await screen.getByText('Download the agent file').click();
		await screen.getByRole('button', { name: 'Windows' }).click();
		await expect
			.element(screen.getByRole('link', { name: 'Download agent' }))
			.toHaveAttribute('href', '/agent/v1/releases/0.1.0/x86_64-pc-windows-msvc');
		expect(screen.container.textContent).not.toContain("Choose the machine's processor");
	});

	it('M3: the command beside the file, with the server and a join code made when the page opens', async () => {
		stubJoinCodes();
		const screen = await renderPage(DOWNLOADS, false);
		await screen.getByRole('button', { name: 'Linux' }).click();
		await screen.getByText('Download the agent file').click();
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
		await screen.getByRole('button', { name: 'Linux' }).click();
		await screen.getByText('Download the agent file').click();
		await expect.element(screen.getByText('For deployment tools')).toBeVisible();
		await expect
			.element(screen.getByText(/up to 100 machines,\s+for\s+up\s+to 7 days/))
			.toBeVisible();

		await screen.getByRole('button', { name: '100' }).click();
		await screen.getByRole('button', { name: '7 days' }).click();
		await screen.getByRole('button', { name: 'Make a roll-out code' }).click();
		const rolloutCode = screen.getByText('RLL-OUT-234');
		await expect.element(rolloutCode).toBeVisible();
		const joinCode = rolloutCode.element().closest('.join-code');
		expect(joinCode).not.toBeNull();
		if (joinCode === null) {
			throw new Error('Roll-out code should be inside its centred container');
		}
		expect(getComputedStyle(joinCode).textAlign).toBe('center');
		// The first request is the code made when the page opens; the second is the roll-out code.
		expect(bodies).toEqual([
			{ maxUses: 1, minutes: 60, machineGroupIds: [] },
			{ maxUses: 100, minutes: 10080, machineGroupIds: [] }
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

describe('Add machine: machine groups (SPEC-ACCESS A7)', () => {
	it('A7: picking groups makes a code that puts the machine in them; roll-out codes too', async () => {
		const { bodies } = stubJoinCodes();
		const screen = await renderPage(DOWNLOADS, false);
		await expect.poll(() => bodies).toHaveLength(1);
		await screen.getByRole('checkbox', { name: 'Office' }).first().click();
		// The code carries its groups, so a new one is made at once.
		await expect.poll(() => bodies).toHaveLength(2);
		expect(bodies[1]).toEqual({ maxUses: 1, minutes: 60, machineGroupIds: [OFFICE] });

		await screen.getByRole('button', { name: 'Linux' }).click();
		await screen.getByText('Download the agent file').click();
		await screen.getByRole('checkbox', { name: 'Lab' }).last().click();
		await screen.getByRole('button', { name: 'Make a roll-out code' }).click();
		await expect.poll(() => bodies).toHaveLength(3);
		expect(bodies[2]).toEqual({ maxUses: 25, minutes: 1440, machineGroupIds: [LAB] });
	});
});

describe('Add machine: local network mode', () => {
	it('L5: shows the pin and the browser fingerprint, and every command carries the pin', async () => {
		const { bodies } = stubJoinCodes();
		const screen = await renderPage(DOWNLOADS, false, LOCAL_TLS);
		await screen.getByRole('button', { name: 'Linux' }).click();
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
		await screen.getByRole('button', { name: 'Linux' }).click();
		await screen.getByText('Download the agent file').click();
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
		await screen.getByRole('button', { name: 'Linux' }).click();
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
		await screen.getByRole('button', { name: 'Linux' }).click();
		await expect.element(screen.getByText(/Restart\s+BMuster to apply it/)).toBeVisible();
		await expect
			.element(
				screen.getByText(`curl -fsSL ${ORIGIN}/install.sh | sudo sh -s -- --code ABC-DEF-GHJ`)
			)
			.toBeVisible();
	});
});

describe('Add machine: what happened to the join code', () => {
	it('waits for a machine, then says which machine used the code with a link, and stops asking', async () => {
		const { statusRequests, statuses } = stubJoinCodes();
		const screen = await renderPage(DOWNLOADS, false);
		await expect.element(screen.getByText('Waiting for a machine to join…')).toBeVisible();

		const machineId = '33333333-3333-4333-8333-333333333333';
		statuses.set(SINGLE_ID, {
			...OPEN,
			uses: 1,
			state: 'used-up',
			machines: [
				{
					id: machineId,
					name: 'Build server',
					enrolledAtIso: '2026-11-08T09:10:00.000Z',
					removed: false
				}
			]
		});
		await expect
			.element(screen.getByRole('link', { name: 'Build server' }), { timeout: 5000 })
			.toHaveAttribute('href', `/machines/${machineId}`);
		await expect.element(screen.getByText(/^Used by/)).toBeVisible();

		// The code cannot change any more, so the page stops asking.
		const asked = statusRequests();
		await new Promise((done) => setTimeout(done, 3500));
		expect(statusRequests()).toBe(asked);
	});

	it('says when a single-use code expired unused, and offers a new one', async () => {
		const { bodies, statuses } = stubJoinCodes();
		statuses.set(SINGLE_ID, { ...OPEN, state: 'expired' });
		const screen = await renderPage(DOWNLOADS, false);
		await expect.element(screen.getByText(/^Expired at .*Nothing joined with it\.$/)).toBeVisible();
		await screen.getByRole('button', { name: 'Make a new code' }).click();
		await expect.poll(() => bodies).toHaveLength(2);
	});

	it('counts a roll-out code and names the newest five machines, then how many more', async () => {
		const { statuses } = stubJoinCodes();
		statuses.set(ROLLOUT_ID, {
			...OPEN,
			maxUses: 100,
			uses: 7,
			machines: Array.from({ length: 7 }, (_, index) => ({
				id: `44444444-4444-4444-8444-44444444444${index}`,
				name: `Laptop ${7 - index}`,
				enrolledAtIso: '2026-11-08T09:10:00.000Z',
				removed: index === 1
			}))
		});
		const screen = await renderPage(DOWNLOADS, false);
		await screen.getByRole('button', { name: 'Linux' }).click();
		await screen.getByText('Download the agent file').click();
		await screen.getByRole('button', { name: 'Make a roll-out code' }).click();
		await expect.element(screen.getByText('7 of 100 machines joined')).toBeVisible();
		const names = screen.getByRole('list', { name: 'Machines that joined, newest first' });
		await expect.element(screen.getByText('and 2 more')).toBeVisible();
		expect(
			[...names.element().querySelectorAll('li')].map((item) => item.textContent.trim())
		).toEqual(['Laptop 7', 'Laptop 6 (removed)', 'Laptop 5', 'Laptop 4', 'Laptop 3', 'and 2 more']);
		await expect
			.element(screen.getByRole('link', { name: 'Laptop 7' }))
			.toHaveAttribute('href', '/machines/44444444-4444-4444-8444-444444444440');
		// A removed machine has no page to link to.
		expect(names.element().querySelectorAll('a')).toHaveLength(4);
	});
});
