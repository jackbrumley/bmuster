import { describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { LinuxDisplay } from '#lib/domain/machines/display-report.ts';
import DisplayCard from './display-card.svelte';

const FEDORA: LinuxDisplay = {
	kind: 'linux',
	seat: {
		kind: 'active',
		sessionType: 'wayland',
		class: 'user',
		desktop: 'GNOME',
		state: 'active',
		lockedHint: { kind: 'known', locked: true }
	},
	cards: [
		{ name: 'card0', driver: 'nvidia', kms: true, connectors: [] },
		{
			name: 'card1',
			driver: 'i915',
			kms: true,
			connectors: [{ name: 'eDP-1', modes: ['1920x1080', '1280x720'] }]
		}
	],
	uinput: { device: true, module: false },
	nvidiaModeset: { kind: 'present', value: 'N' },
	programs: { xdgDesktopPortal: true, gstreamer: true, pipewiresrc: false },
	kernel: '6.17.1-300.fc43.x86_64',
	agentVersion: '0.4.0',
	launcherVersion: { kind: 'known', version: '0.3.3' }
};

describe('Overview: Display card (SPEC-AGENT-LOGS AL12)', () => {
	it('AL12: renders the machine report', async () => {
		const screen = await render(DisplayCard, { report: FEDORA });
		const fact = (label: string) =>
			screen.getByText(label, { exact: true }).element().nextElementSibling;
		await expect.element(screen.getByRole('heading', { name: 'Display' })).toBeVisible();
		expect(fact('Session')?.textContent).toBe('wayland (user, active, locked) · GNOME');
		expect(fact('card0')?.textContent).toBe('nvidia · nothing connected');
		expect(fact('card1')?.textContent).toBe('i915 · eDP-1 1920x1080');
		expect(fact('uinput')?.textContent).toBe('Device yes, module no');
		expect(fact('NVIDIA modeset')?.textContent).toBe('N');
		expect(fact('GStreamer')?.textContent).toBe('Yes, pipewiresrc missing');
		expect(fact('Kernel')?.textContent).toBe('6.17.1-300.fc43.x86_64');
		expect(fact('Agent')?.textContent).toBe('v0.4.0, launcher v0.3.3');
	});

	it('AL12: says what is missing for Windows, older agents and no inventory yet', async () => {
		const windows = await render(DisplayCard, {
			report: { kind: 'windows', console: { kind: 'user', name: 'kim' } }
		});
		await expect.element(windows.getByText('kim')).toBeVisible();
		await windows.unmount();
		const old = await render(DisplayCard, { report: { kind: 'unreported' } });
		await expect
			.element(old.getByText('This agent is too old to report its display; update it.'))
			.toBeVisible();
		await old.unmount();
		const pending = await render(DisplayCard, { report: undefined });
		await expect.element(pending.getByText('Waiting for the first inventory.')).toBeVisible();
	});

	it('AL12: at phone width the card does not overflow', async () => {
		await page.viewport(390, 844);
		const screen = await render(DisplayCard, {
			report: {
				...FEDORA,
				cards: [
					{
						name: 'card1',
						driver: 'a-very-long-driver-name-without-spaces-at-all-anywhere',
						kms: true,
						connectors: [{ name: 'DP-1', modes: ['7680x4320'] }]
					}
				]
			}
		});
		await expect.element(screen.getByRole('heading', { name: 'Display' })).toBeVisible();
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
	});
});
