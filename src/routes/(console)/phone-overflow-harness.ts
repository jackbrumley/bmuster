import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { PERMISSIONS, type Grant } from '#lib/domain/access/access.ts';
import { FakeEventSource } from '#tests/helpers/fake-event-source.ts';
import { FakeSocket } from '#tests/helpers/fake-socket.ts';
import { ADMIN, longDataReply, MACHINE, NOW, pastRightEdge } from '#tests/helpers/long-data.ts';
import ConsoleFrame from './console-frame.svelte';

/**
 * SPEC-PHONE-LAYOUT U1: no console page scrolls sideways on a 360 px phone, with the longest names,
 * hostnames, folder names and descriptions real fleets have. Each page renders inside the real
 * console frame (and, for a machine tab, the machine layout). Shared by the console pages' test
 * (phone-overflow.svelte.test.ts) and the machine tabs' (phone-overflow-machine-tabs.svelte.test.ts).
 */

const PHONE = { width: 360, height: 780 };

export const CONSOLE = {
	user: ADMIN,
	localNetworkMode: true,
	serverUpdate: null,
	runCommands: true,
	signedIn: true
};
const GRANTS: Grant[] = PERMISSIONS.map((permission) => ({ permission, consent: 'unattended' }));
export const MACHINE_DATA = { ...CONSOLE, now: NOW, machine: MACHINE, grants: GRANTS };
export const IN_CONSOLE = {
	wrapper: ConsoleFrame,
	wrapperProps: { frame: { kind: 'console' as const, data: CONSOLE } }
};
export const ON_MACHINE = {
	wrapper: ConsoleFrame,
	wrapperProps: { frame: { kind: 'machine' as const, data: MACHINE_DATA } }
};

/** A page or tab, with the text that shows once it has its data. */
export type PhonePage = { name: string; ready: string; open: () => Promise<unknown> };

/** Before each test: a phone-sized page, empty storage, and a server answering with long data. */
export async function stubPhoneServer(): Promise<void> {
	await page.viewport(PHONE.width, PHONE.height);
	localStorage.clear();
	sessionStorage.clear();
	vi.stubGlobal('EventSource', FakeEventSource);
	vi.stubGlobal('WebSocket', FakeSocket);
	vi.stubGlobal(
		'fetch',
		vi.fn((input: string) => Promise.resolve(longDataReply(new URL(input, location.origin))))
	);
}

/** U1 for each page: once its data shows, the page is no wider than the phone. */
export function checkPhoneWidth(pages: readonly PhonePage[]): void {
	describe('phone width (SPEC-PHONE-LAYOUT U1)', () => {
		it.each(pages)('U1: $name does not scroll sideways at 360 px', async ({ ready, open }) => {
			await open();
			await expect.poll(() => document.body.textContent).toContain(ready);
			expect(document.documentElement.scrollWidth, pastRightEdge(PHONE.width)).toBeLessThanOrEqual(
				PHONE.width
			);
		});
	});
}
