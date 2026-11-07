import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { Grant } from '#lib/domain/access/access.ts';
import type { Machine } from '#lib/domain/machines/machine.ts';
import DesktopTab from './desktop/+page.svelte';
import FilesTab from './files/+page.svelte';
import TerminalTab from './terminal/+page.svelte';

const MACHINE: Machine = {
	id: '11111111-1111-4111-8111-111111111111',
	name: 'Reception PC',
	description: '',
	hostname: 'reception',
	osFamily: 'linux',
	target: 'x86_64-unknown-linux-gnu',
	agentVersion: '0.2.0',
	status: { kind: 'online' },
	lastUser: { kind: 'none' },
	live: { kind: 'none' },
	inventory: { kind: 'pending' },
	enrolledIso: '2026-11-01T00:00:00.000Z',
	lastSeenIso: '2026-11-07T12:00:00.000Z',
	inUse: []
};

function props(grants: Grant[]) {
	return {
		params: { id: MACHINE.id },
		form: undefined,
		data: {
			user: { id: 'm', name: 'Mo', email: 'mo@example.com', role: 'member' as const },
			localNetworkMode: false,
			now: Date.parse('2026-11-07T12:00:00.000Z'),
			machine: MACHINE,
			grants
		}
	};
}

const VIEW_ONLY: Grant[] = [{ permission: 'view', consent: 'ask' }];
const NO_PERMISSION = "You don't have permission for this.";

describe('machine tabs without the permission (SPEC-ACCESS A6)', () => {
	it('Terminal, Desktop and Files say so when the rules do not allow them', async () => {
		for (const Tab of [TerminalTab, DesktopTab, FilesTab]) {
			const screen = await render(Tab, props(VIEW_ONLY));
			await expect.element(screen.getByText(NO_PERMISSION)).toBeVisible();
			await screen.unmount();
		}
	});

	it('opens each tab when its permission is there', async () => {
		const terminal = await render(
			TerminalTab,
			props([...VIEW_ONLY, { permission: 'terminal', consent: 'ask' }])
		);
		await expect.element(terminal.getByLabelText('Command')).toBeVisible();
		expect(terminal.container.textContent).not.toContain(NO_PERMISSION);
		await terminal.unmount();
		const desktop = await render(
			DesktopTab,
			props([...VIEW_ONLY, { permission: 'desktop-view', consent: 'ask' }])
		);
		expect(desktop.container.textContent).not.toContain(NO_PERMISSION);
		await desktop.unmount();
		const files = await render(
			FilesTab,
			props([...VIEW_ONLY, { permission: 'files', consent: 'ask' }])
		);
		expect(files.container.textContent).not.toContain(NO_PERMISSION);
	});
});
