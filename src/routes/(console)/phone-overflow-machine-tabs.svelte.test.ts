import '../../app.css';
import { beforeEach, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import {
	LONG_GROUP,
	LONG_HOSTNAME,
	LONG_PERSON,
	LONG_WORD,
	DOWNLOADS,
	LINUX_MACHINE,
	LOCAL_TLS,
	MACHINE_GROUPS,
	MACHINE,
	LONG_RECIPIENT
} from '#tests/helpers/long-data.ts';
import OverviewTab from './machines/[id]/+page.svelte';
import DesktopTab from './machines/[id]/desktop/+page.svelte';
import FilesTab from './machines/[id]/files/+page.svelte';
import ManageTab from './machines/[id]/manage/+page.svelte';
import NotesTab from './machines/[id]/notes/+page.svelte';
import StorageTab from './machines/[id]/storage/+page.svelte';
import TerminalTab from './machines/[id]/terminal/+page.svelte';
import ConsoleFrame from './console-frame.svelte';
import {
	checkPhoneWidth,
	MACHINE_DATA,
	ON_MACHINE,
	stubPhoneServer,
	type PhonePage
} from './phone-overflow-harness.ts';

/**
 * SPEC-PHONE-LAYOUT U1 for the machine tabs (the console's own pages are in
 * phone-overflow.svelte.test.ts); the setup is in phone-overflow-harness.ts.
 */

vi.mock('$app/navigation', () => ({ refreshAll: () => Promise.resolve(), goto: vi.fn() }));
vi.mock('$app/state', () => ({
	page: {
		url: new URL('https://bmuster.example-company.com.au/'),
		route: { id: '/(console)' },
		params: {},
		status: 200,
		error: null
	}
}));

/** Every machine tab. */
const PAGES: PhonePage[] = [
	{
		name: 'Machine overview',
		ready: LONG_HOSTNAME,
		open: () => render(OverviewTab, { params: { id: MACHINE.id }, data: MACHINE_DATA }, ON_MACHINE)
	},
	{
		name: 'Machine overview, share links',
		ready: LONG_RECIPIENT,
		open: () => render(OverviewTab, { params: { id: MACHINE.id }, data: MACHINE_DATA }, ON_MACHINE)
	},
	{
		name: 'Terminal',
		ready: LONG_HOSTNAME,
		open: () => render(TerminalTab, { params: { id: MACHINE.id }, data: MACHINE_DATA }, ON_MACHINE)
	},
	{
		name: 'Desktop',
		ready: LONG_HOSTNAME,
		open: () => render(DesktopTab, { params: { id: MACHINE.id }, data: MACHINE_DATA }, ON_MACHINE)
	},
	{
		name: 'Files (Windows drives)',
		ready: LONG_WORD,
		open: () => render(FilesTab, { params: { id: MACHINE.id }, data: MACHINE_DATA }, ON_MACHINE)
	},
	{
		name: 'Files (a Linux folder two levels down)',
		ready: `${LONG_WORD}.xlsx`,
		open: async () => {
			const data = { ...MACHINE_DATA, machine: LINUX_MACHINE };
			await render(
				FilesTab,
				{ params: { id: LINUX_MACHINE.id }, data },
				{ wrapper: ConsoleFrame, wrapperProps: { frame: { kind: 'machine' as const, data } } }
			);
			for (const _level of [1, 2]) {
				await page.getByText(LONG_WORD, { exact: true }).first().click();
			}
		}
	},
	{
		name: 'Storage (drives)',
		ready: `/media/${LONG_WORD}`,
		open: openStorage
	},
	{
		name: 'Storage (a folder two levels down)',
		ready: `${LONG_WORD}-cache`,
		open: async () => {
			await openStorage();
			await page.getByRole('button', { name: /^Used on / }).click();
			await page.getByRole('button', { name: new RegExp(`^${LONG_WORD}-cache`) }).click();
		}
	},
	{
		name: 'Notes',
		ready: LONG_WORD,
		open: () =>
			render(
				NotesTab,
				{
					params: { id: MACHINE.id },
					form: undefined,
					data: {
						...MACHINE_DATA,
						notes: [
							{
								id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
								authorName: LONG_PERSON,
								body: `Replaced the toner. ${LONG_WORD} ${LONG_HOSTNAME}`,
								createdIso: '2026-11-11T00:00:00.000Z',
								edited: { kind: 'yes', editedIso: '2026-11-12T00:00:00.000Z' },
								canEdit: true,
								canDelete: true
							}
						]
					}
				},
				ON_MACHINE
			)
	},
	{
		name: 'Manage',
		ready: LONG_GROUP,
		open: () =>
			render(
				ManageTab,
				{
					params: { id: MACHINE.id },
					form: undefined,
					data: {
						...MACHINE_DATA,
						downloads: DOWNLOADS,
						localTls: LOCAL_TLS,
						localPage: {
							kind: 'reported',
							address: `https://${LONG_HOSTNAME}:47100/`,
							fingerprint: 'AB:'.repeat(31) + 'AB',
							reportedIso: '2026-11-12T00:00:00.000Z'
						},
						machineGroups: MACHINE_GROUPS,
						verboseUntilIso: '2026-11-12T12:00:00.000Z',
						keepAwakeOnAc: true
					}
				},
				ON_MACHINE
			)
	}
];

function openStorage() {
	return render(
		StorageTab,
		{
			params: { id: MACHINE.id },
			form: undefined,
			data: { ...MACHINE_DATA, reported: { kind: 'none' } }
		},
		ON_MACHINE
	);
}

beforeEach(stubPhoneServer);

checkPhoneWidth(PAGES);
