import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { Machine } from '#lib/domain/machines/machine.ts';
import type { NoteView } from '#lib/schemas/machines/machine-notes.ts';
import NotesTab from './+page.svelte';

const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const MACHINE_ID = '11111111-1111-4111-8111-111111111111';

const MACHINE: Machine = {
	id: MACHINE_ID,
	name: 'Reception PC',
	description: '',
	hostname: 'reception',
	osFamily: 'windows',
	target: 'x86_64-pc-windows-msvc',
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

const NOTES: NoteView[] = [
	{
		id: '22222222-2222-4222-8222-222222222222',
		authorName: 'Ben',
		body: 'Replaced the <b>PSU</b>.\nOld one in the drawer.',
		createdIso: '2026-11-07T11:00:00.000Z',
		edited: { kind: 'yes', editedIso: '2026-11-07T11:30:00.000Z' },
		canEdit: false,
		canDelete: true
	},
	{
		id: '33333333-3333-4333-8333-333333333333',
		authorName: 'Ada',
		body: 'Do not reboot during business hours.',
		createdIso: '2026-11-05T12:00:00.000Z',
		edited: { kind: 'no' },
		canEdit: true,
		canDelete: true
	}
];

function renderTab(notes: NoteView[]) {
	return render(NotesTab, {
		params: { id: MACHINE_ID },
		form: undefined,
		data: {
			user: { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'admin' },
			localNetworkMode: false,
			serverUpdate: null,
			signedIn: true,
			now: NOW,
			machine: MACHINE,
			grants: [{ permission: 'view', consent: 'unattended' }],
			notes
		}
	});
}

describe('Notes tab (D3, D4)', () => {
	it('lists notes newest first with author, time, edited marker and plain text', async () => {
		const screen = await renderTab(NOTES);
		const items = screen.getByRole('listitem').all();
		expect(items).toHaveLength(2);
		expect(items.map((item) => item.element().textContent)).toEqual([
			expect.stringContaining('Ben'),
			expect.stringContaining('Ada')
		]);
		await expect.element(screen.getByText('edited')).toBeVisible();
		await expect.element(screen.getByText('2 days ago')).toBeVisible();

		const body = screen.container.querySelector('.body');
		// Shown as typed: no HTML is made from it, and the line break stays.
		expect(body?.textContent).toBe('Replaced the <b>PSU</b>.\nOld one in the drawer.');
		expect(body?.querySelector('b')).toBeNull();
		expect(body === null ? '' : getComputedStyle(body).whiteSpace).toBe('pre-wrap');
	});

	it('offers Edit only on your own notes and Delete where allowed', async () => {
		const screen = await renderTab(NOTES);
		expect(screen.getByRole('button', { name: 'Edit note' }).all()).toHaveLength(1);
		expect(screen.getByRole('button', { name: 'Delete note' }).all()).toHaveLength(2);
	});

	it('says so when there are no notes yet', async () => {
		const screen = await renderTab([]);
		await expect.element(screen.getByText(/No notes yet/)).toBeVisible();
	});
});
