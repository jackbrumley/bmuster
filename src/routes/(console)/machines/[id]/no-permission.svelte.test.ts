import { describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { Grant } from '#lib/domain/access/access.ts';
import type { Machine } from '#lib/domain/machines/machine.ts';
import DesktopTab from './desktop/+page.svelte';
import FilesTab from './files/+page.svelte';
import TerminalTab from './terminal/+page.svelte';
import { presenceOf, underMachineLayout } from '#tests/helpers/machine-presence.ts';

const MACHINE: Machine = {
	id: '11111111-1111-4111-8111-111111111111',
	name: 'Reception PC',
	description: '',
	hostname: 'reception',
	osFamily: 'linux',
	target: 'x86_64-unknown-linux-gnu',
	agentVersion: '0.2.0',
	update: { kind: 'up-to-date' },
	status: { kind: 'online' },
	lastUser: { kind: 'none' },
	live: { kind: 'none' },
	inventory: { kind: 'pending' },
	enrolledIso: '2026-11-01T00:00:00.000Z',
	lastSeenIso: '2026-11-07T12:00:00.000Z',
	inUse: [],
	lowDisk: []
};

function props(grants: Grant[]) {
	return {
		params: { id: MACHINE.id },
		form: undefined,
		data: {
			user: { id: 'm', name: 'Mo', email: 'mo@example.com', role: 'member' as const },
			localNetworkMode: false,
			serverUpdate: null,
			runCommands: false,
			assistant: { kind: 'none' as const },
			signedIn: true,
			now: Date.parse('2026-11-07T12:00:00.000Z'),
			machine: MACHINE,
			grants
		}
	};
}

/** The machine layout's live status, as the tabs get it (SPEC-PRESENCE P10). */
function layout() {
	return underMachineLayout(presenceOf(MACHINE, props([]).data.now));
}

const VIEW_ONLY: Grant[] = [{ permission: 'view', consent: 'ask' }];
const NO_PERMISSION = "You don't have permission for this.";

describe('machine tabs without the permission (SPEC-ACCESS A6)', () => {
	it('Terminal, Desktop and Files say so when the rules do not allow them', async () => {
		for (const Tab of [TerminalTab, DesktopTab, FilesTab]) {
			const screen = await render(Tab, props(VIEW_ONLY), layout());
			await expect.element(screen.getByText(NO_PERMISSION)).toBeVisible();
			await screen.unmount();
		}
	});

	it('opens each tab when its permission is there', async () => {
		const terminal = await render(
			TerminalTab,
			props([...VIEW_ONLY, { permission: 'terminal', consent: 'ask' }]),
			layout()
		);
		await expect.element(terminal.getByRole('group', { name: 'Shell' })).toBeVisible();
		expect(terminal.container.textContent).not.toContain(NO_PERMISSION);
		await terminal.unmount();
		const desktop = await render(
			DesktopTab,
			props([...VIEW_ONLY, { permission: 'desktop-view', consent: 'ask' }]),
			layout()
		);
		expect(desktop.container.textContent).not.toContain(NO_PERMISSION);
		await desktop.unmount();
		// The Files tab lists a folder as it opens; nothing here needs the answer.
		vi.stubGlobal(
			'fetch',
			vi.fn(() => Promise.resolve(Response.json({ message: 'Not here.' }, { status: 404 })))
		);
		const files = await render(
			FilesTab,
			props([...VIEW_ONLY, { permission: 'files', consent: 'ask' }]),
			layout()
		);
		expect(files.container.textContent).not.toContain(NO_PERMISSION);
	});
});
