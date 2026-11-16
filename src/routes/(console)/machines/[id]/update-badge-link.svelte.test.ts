import { createRawSnippet } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { resolve } from '$app/paths';
import { PERMISSIONS, type Grant } from '#lib/domain/access/access.ts';
import type { Machine } from '#lib/domain/machines/machine.ts';
import { fakeAppPage } from '#tests/helpers/fake-app-page.svelte.ts';
import { FakeEventSource } from '#tests/helpers/fake-event-source.ts';
import { DOWNLOADS, LOCAL_TLS, longDataReply } from '#tests/helpers/long-data.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import MachineLayout from './+layout.svelte';
import ManagePage from './manage/+page.svelte';

/**
 * SPEC-AGENT-UPDATES U15 on a machine's own pages: the header's update badge links to Manage →
 * Agent update for people who may update the agent, and that section is focused and highlighted
 * when the link opens it. The Machines cards, table and phone list are in machines-page.svelte.test.ts.
 */

vi.mock('$app/state', async () => ({
	page: (await import('#tests/helpers/fake-app-page.svelte.ts')).fakeAppPage
}));
vi.mock('$app/navigation', () => ({
	refreshAll: vi.fn(() => Promise.resolve()),
	goto: vi.fn(() => Promise.resolve())
}));

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const OUT_OF_DATE: Machine = {
	...TEST_MACHINE,
	name: 'AUADRNBK00007',
	update: { kind: 'available', version: '0.5.3', needsReinstall: false }
};
const MANAGE = resolve('/(console)/machines/[id]/manage', { id: OUT_OF_DATE.id });
const GRANTS: Grant[] = PERMISSIONS.map((permission) => ({ permission, consent: 'unattended' }));

function layoutData(role: 'admin' | 'member') {
	return {
		user: { id: 'a', name: 'Ada', email: 'ada@example.com', role },
		localNetworkMode: false,
		canUpdateAgents: role === 'admin',
		serverUpdate: null,
		runCommands: false,
		assistant: { kind: 'none' as const },
		approvals: { kind: 'hidden' as const },
		signedIn: true,
		now: NOW,
		machine: OUT_OF_DATE,
		grants: GRANTS
	};
}

const tabContent = createRawSnippet(() => ({ render: () => '<p>Tab content</p>' }));

beforeEach(async () => {
	vi.stubGlobal('EventSource', FakeEventSource);
	vi.stubGlobal(
		'fetch',
		vi.fn((input: string) => Promise.resolve(longDataReply(new URL(input, location.origin))))
	);
	await page.viewport(1280, 800);
});

afterEach(() => {
	fakeAppPage.url = new URL('https://bmuster.test/');
});

describe('the machine header (U15)', () => {
	it('U15: links the update badge to Manage → Agent update for someone who may update agents', async () => {
		const screen = await render(MachineLayout, {
			params: { id: OUT_OF_DATE.id },
			data: layoutData('admin'),
			children: tabContent
		});
		const badge = screen.getByRole('link', {
			name: "Update available: update AUADRNBK00007's agent to 0.5.3"
		});
		await expect.element(badge).toHaveAttribute('href', `${MANAGE}#agent-update`);
		await expect.element(badge).toHaveTextContent('Update available');
	});

	it('U15: shows a plain badge to someone who may not update agents', async () => {
		const screen = await render(MachineLayout, {
			params: { id: OUT_OF_DATE.id },
			data: layoutData('member'),
			children: tabContent
		});
		await expect.element(screen.getByText('Update available')).toBeVisible();
		expect(screen.container.querySelector('[data-update-state]')?.tagName).toBe('SPAN');
		expect(screen.getByRole('link', { name: /Update available/ }).all()).toHaveLength(0);
	});
});

describe('Manage → Agent update (U15)', () => {
	function openManage() {
		return render(ManagePage, {
			params: { id: OUT_OF_DATE.id },
			form: undefined,
			data: {
				...layoutData('admin'),
				downloads: DOWNLOADS,
				localTls: LOCAL_TLS,
				localPage: { kind: 'none' },
				machineGroups: [],
				verboseUntilIso: null,
				keepAwakeOnAc: false
			}
		});
	}

	it('U15: focuses and highlights the Agent section when opened with #agent-update', async () => {
		fakeAppPage.url = new URL(`https://bmuster.test${MANAGE}#agent-update`);
		const screen = await openManage();
		const section = screen.container.querySelector('#agent-update');
		expect(section).not.toBeNull();
		await expect.poll(() => document.activeElement).toBe(section);
		expect(section?.classList.contains('highlighted')).toBe(true);
		await expect.element(screen.getByRole('button', { name: 'Update now' })).toBeVisible();
		// The highlight is a moment's pointer, not a lasting state.
		await expect
			.poll(() => section?.classList.contains('highlighted'), { timeout: 4000 })
			.toBe(false);
	});

	it('U15: leaves the focus and the Agent section alone when opened without it', async () => {
		fakeAppPage.url = new URL(`https://bmuster.test${MANAGE}`);
		const screen = await openManage();
		await expect.element(screen.getByRole('button', { name: 'Update now' })).toBeVisible();
		const section = screen.container.querySelector('#agent-update');
		expect(section?.classList.contains('highlighted')).toBe(false);
		expect(document.activeElement).not.toBe(section);
	});
});
