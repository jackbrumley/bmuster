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
	launcherVersion: { kind: 'known', version: '0.3.3' },
	selinux: {
		kind: 'present',
		enforcing: true,
		agentContext: 'system_u:system_r:unconfined_service_t:s0',
		initContext: 'system_u:system_r:init_t:s0'
	}
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
		expect(fact('SELinux')?.textContent).toBe('Enforcing');
		expect(fact('Agent context')?.textContent).toBe('system_u:system_r:unconfined_service_t:s0');
		expect(fact('systemd context')?.textContent).toBe('system_u:system_r:init_t:s0');
	});

	it('AL12: says what is missing for Windows, older agents and no inventory yet', async () => {
		const windows = await render(DisplayCard, {
			report: {
				kind: 'windows',
				console: { kind: 'user', name: 'kim' },
				system: { kind: 'unreported' }
			}
		});
		await expect.element(windows.getByText('kim')).toBeVisible();
		await expect.element(windows.getByText('Not reported by this agent')).toBeVisible();
		await windows.unmount();
		const old = await render(DisplayCard, { report: { kind: 'unreported' } });
		await expect
			.element(old.getByText('This agent is too old to report its display; update it.'))
			.toBeVisible();
		await old.unmount();
		const pending = await render(DisplayCard, { report: undefined });
		await expect.element(pending.getByText('Waiting for the first inventory.')).toBeVisible();
	});

	it('D8: renders the Windows build, console session, secure desktop, outputs and SAS policy', async () => {
		const screen = await render(DisplayCard, {
			report: {
				kind: 'windows',
				console: { kind: 'none' },
				system: {
					kind: 'reported',
					build: '26100.2314',
					edition: 'Professional',
					consoleSession: { kind: 'attached', id: 1, state: 'active' },
					secureDesktop: { kind: 'known', active: true },
					outputs: {
						kind: 'read',
						list: [
							{
								adapter: 'Intel(R) UHD Graphics',
								name: '\\\\.\\DISPLAY1',
								width: 1920,
								height: 1080,
								rotation: 90
							}
						]
					},
					sasPolicy: { kind: 'set', value: 3 }
				}
			}
		});
		const fact = (label: string) =>
			[...screen.container.querySelectorAll('.fact')]
				.find((element) => element.querySelector('dt')?.textContent === label)
				?.querySelector('dd');
		await expect.element(screen.getByText('Build 26100.2314 Professional')).toBeVisible();
		expect(fact('Console session')?.textContent).toBe('1 (active)');
		expect(fact('Secure desktop')?.textContent).toBe('Showing (sign-in, lock or UAC)');
		expect(fact('\\\\.\\DISPLAY1')?.textContent).toBe(
			'Intel(R) UHD Graphics · 1920x1080, rotated 90°'
		);
		expect(fact('SAS policy')?.textContent).toBe('3 (services and apps)');
	});

	it('DW5: says why the outputs are missing instead of an empty list', async () => {
		const outputsShown = async (
			outputs:
				| { kind: 'read'; list: [] }
				| { kind: 'failed'; reason: string }
				| { kind: 'service-session'; list: [] }
		) => {
			const screen = await render(DisplayCard, {
				report: {
					kind: 'windows',
					console: { kind: 'user', name: 'kim' },
					system: {
						kind: 'reported',
						build: '19045.6456',
						edition: 'Professional',
						consoleSession: { kind: 'attached', id: 1, state: 'active' },
						secureDesktop: { kind: 'unknown' },
						outputs,
						sasPolicy: { kind: 'not-set' }
					}
				}
			});
			const shown = [...screen.container.querySelectorAll('.fact')]
				.find((element) => element.querySelector('dt')?.textContent === 'Outputs')
				?.querySelector('dd')?.textContent;
			await screen.unmount();
			return shown;
		};
		expect(
			await outputsShown({ kind: 'failed', reason: 'The display helper did not answer in 10 s.' })
		).toBe('Could not read: The display helper did not answer in 10 s.');
		expect(await outputsShown({ kind: 'read', list: [] })).toBe('None found');
		expect(await outputsShown({ kind: 'service-session', list: [] })).toBe(
			'Not visible to this agent version; update it'
		);
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
