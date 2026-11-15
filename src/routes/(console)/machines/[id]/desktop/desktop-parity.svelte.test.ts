import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent, type Locator } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { Grant } from '#lib/domain/access/access.ts';
import type { ClipboardOffer } from '#lib/domain/session-files/session-files.ts';
import { showToast, toasts } from '#lib/ui/toast.svelte.ts';
import { FakeSocket } from '#tests/helpers/fake-socket.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import '#lib/ui/design-tokens.css';
import GuestPage from '../../../../s/[token]/guest-page.svelte';
import { batch, CONTROL, renderTab } from './desktop-test-harness.ts';
import { PHONE_QUERY } from './pop-out.ts';
import { CHROME_ACTIONS, FILE_ACTIONS, type ChromeAction } from './session-actions.ts';
import DesktopWindow from './window/+page@.svelte';

// SPEC-DESKTOP 23 (DP1–DP3, DP5–DP8): every desktop view offers the same session features.
// A new ChromeAction must be added to ON_BAR and IN_SHEET below, or this file stops compiling.

const SESSION = '66666666-6666-4666-8666-666666666666';
const MACHINE = { ...TEST_MACHINE, osFamily: 'windows' as const };
const FILES: Grant[] = [...CONTROL, { permission: 'files', consent: 'unattended' }];
const OFFER: ClipboardOffer = {
	kind: 'offer',
	offerId: '0123456789abcdef0123456789abcdef',
	items: [
		{ name: 'report.pdf', kind: 'file', size: 10 },
		{ name: 'Photos', kind: 'folder', size: 0 }
	],
	count: 2,
	totalBytes: 10
};
const WAITING = '2 files copied on the machine';
const TWO_DISPLAYS = {
	type: 'displays',
	list: [
		{ id: 'A', name: 'Left', x: 0, y: 0, width: 200, height: 100, scale: 1, primary: true },
		{ id: 'B', name: 'Right', x: 200, y: 0, width: 200, height: 100, scale: 1, primary: false }
	],
	current: 'A'
};

let address = '';

beforeEach(async () => {
	await page.viewport(1280, 900);
	sessionStorage.clear();
	localStorage.clear();
	toasts.list = [];
	address = window.location.href;
	FakeSocket.last = undefined;
	vi.stubGlobal('WebSocket', FakeSocket);
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string) => {
			if (url.includes('/session-files/offer')) return Promise.resolve(Response.json(OFFER));
			if (url.includes('/session-files/transfers')) {
				return Promise.resolve(Response.json({ transfers: [] }));
			}
			if (url.endsWith('/browser-ticket')) {
				return Promise.resolve(Response.json({ kind: 'issued', browserTicket: 't-1' }));
			}
			return Promise.resolve(Response.json({ sessionId: SESSION, browserTicket: 't-1' }));
		})
	);
});

afterEach(async () => {
	history.replaceState(history.state, '', address);
	sessionStorage.clear();
	localStorage.clear();
	if (document.fullscreenElement !== null) await document.exitFullscreen();
});

/** A touch device: a phone, or a tablet wider than the phone layout. */
function touchDevice(kind: 'phone' | 'tablet'): void {
	const real = window.matchMedia.bind(window);
	vi.stubGlobal('matchMedia', (query: string): MediaQueryList => {
		if (query === PHONE_QUERY) return real(kind === 'phone' ? 'all' : 'not all');
		return real(query.includes('pointer: coarse') ? 'all' : query);
	});
}

/** Plays the server's side of a session that just opened: two displays, a picture, a copy. */
async function serve(): Promise<FakeSocket> {
	await expect.poll(() => FakeSocket.last?.url ?? '').toContain('ticket=t-1');
	const socket = FakeSocket.last;
	if (socket === undefined) throw new Error('no socket');
	socket.receive(JSON.stringify({ type: 'attached', resumed: false }));
	socket.receive(JSON.stringify({ type: 'ready' }));
	socket.receive(JSON.stringify(TWO_DISPLAYS));
	socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
	socket.receive(JSON.stringify({ type: 'clipboard-changed', text: 'copied on the machine' }));
	return socket;
}

function stage(): Locator {
	return page.getByRole('application', { name: `Screen of ${MACHINE.name}` });
}

async function openTab(grants: Grant[] = FILES): Promise<FakeSocket> {
	await renderTab(grants, MACHINE);
	await page.getByRole('button', { name: 'Connect' }).click();
	return serve();
}

async function goFullScreen(): Promise<void> {
	await page.getByRole('button', { name: 'Full screen', exact: true }).click();
	await expect.poll(() => document.fullscreenElement !== null).toBe(true);
}

/** The window the tab popped out, joining the running session. */
async function openWindow(): Promise<FakeSocket> {
	history.replaceState(
		history.state,
		'',
		`${window.location.pathname}?sessionId=${SESSION}&mode=control&since=1794000000000`
	);
	await render(DesktopWindow, {
		form: undefined,
		params: { id: MACHINE.id },
		data: { signedIn: true, machine: MACHINE, grants: FILES }
	});
	return serve();
}

async function openGuest(): Promise<FakeSocket> {
	await render(GuestPage, {
		token: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
		guest: {
			machineName: MACHINE.name,
			osFamily: 'windows',
			agentVersion: MACHINE.agentVersion,
			recipient: 'Dave',
			sharedByName: 'Jack Brumley',
			permissions: ['desktop-view', 'desktop-control'],
			expiresIso: new Date(Date.now() + 30 * 60_000).toISOString()
		},
		loadedAtMs: Date.now()
	});
	await page.getByRole('textbox', { name: 'Your name' }).fill('Dave');
	await page.getByRole('button', { name: 'Control the screen' }).click();
	return serve();
}

/** Brings the floating bar back (it hides when the mouse is idle) by moving near the top edge. */
async function revealBar(): Promise<void> {
	await stage().hover({ position: { x: 5, y: 5 } });
}

async function toggles(name: string, opens: Locator, reveal: () => Promise<void>): Promise<void> {
	await reveal();
	await page.getByRole('button', { name, exact: true }).click();
	await expect.element(opens).toBeVisible();
	await reveal();
	await page.getByRole('button', { name, exact: true }).click();
	await expect.element(opens).not.toBeInTheDocument();
}

type Finder = {
	/** The action is there and does what it says. */
	reach: (reveal: () => Promise<void>) => Promise<void>;
	/** The action is nowhere to be seen. */
	absent: () => Promise<void>;
};

function button(name: string | RegExp): Locator {
	return page.getByRole('button', { name, exact: typeof name === 'string' });
}

function shownButton(name: string | RegExp): Finder {
	return {
		reach: async (reveal) => {
			await reveal();
			await expect.element(button(name)).toBeVisible();
		},
		absent: () => expect.element(button(name)).not.toBeInTheDocument()
	};
}

function panelToggle(name: string, opens: Locator): Finder {
	return {
		reach: (reveal) => toggles(name, opens, reveal),
		absent: () => expect.element(button(name)).not.toBeInTheDocument()
	};
}

/** Where each action is on the tab's bar, and on the floating bar of full screen and the pop-out. */
const ON_BAR: Record<ChromeAction, Finder> = {
	mode: shownButton(/^Switch to view only/),
	keys: {
		reach: async (reveal) => {
			await reveal();
			await button('Keys').click();
			await expect.element(button(/^Ctrl\+Alt\+Del/)).toBeVisible();
			await reveal();
			await button('Keys').click();
		},
		absent: () => expect.element(button('Keys')).not.toBeInTheDocument()
	},
	clipboard: panelToggle('Clipboard', page.getByRole('region', { name: 'Clipboard' })),
	upload: shownButton('Upload files'),
	download: shownButton('Download 2 files (zip)'),
	transfers: panelToggle('Transfers', page.getByRole('region', { name: 'Transfers' })),
	settings: panelToggle('Picture settings', page.getByRole('region', { name: 'Picture' })),
	display: {
		reach: async (reveal) => {
			await reveal();
			await expect
				.element(
					page
						.getByRole('group', { name: /^(Display|Screen)$/ })
						.getByRole('button', { name: 'Right' })
				)
				.toBeVisible();
		},
		absent: () =>
			expect
				.element(page.getByRole('group', { name: /^(Display|Screen)$/ }))
				.not.toBeInTheDocument()
	},
	disconnect: shownButton('Disconnect')
};

/** The controls button's sheet, opened on `tab`. */
async function sheetTab(tab: string): Promise<Locator> {
	const sheet = page.getByRole('group', { name: 'Session options' });
	if (sheet.query() === null) {
		await page.getByRole('button', { name: /^Session controls/ }).click();
	}
	await sheet.getByRole('tab', { name: tab }).click();
	return sheet;
}

function inTab(
	tab: string,
	find: (sheet: Locator) => Locator,
	then?: (sheet: Locator) => Promise<void>
): Finder {
	return {
		reach: async () => {
			const sheet = await sheetTab(tab);
			await expect.element(find(sheet)).toBeVisible();
			await then?.(sheet);
		},
		absent: async () => {
			const sheet = await sheetTab('Session');
			await expect.element(find(sheet)).not.toBeInTheDocument();
		}
	};
}

/** Where each action is in the touch layouts: a tab of the controls button's sheet. */
const IN_SHEET: Record<ChromeAction, Finder> = {
	mode: inTab('Session', (sheet) => sheet.getByRole('button', { name: 'Switch to view only' })),
	keys: inTab('Keys', (sheet) => sheet.getByRole('button', { name: /^Ctrl\+Alt\+Del/ })),
	clipboard: inTab('Clipboard', (sheet) => sheet.getByRole('region', { name: 'Clipboard' })),
	upload: inTab('Session', (sheet) => sheet.getByRole('button', { name: 'Upload files' })),
	download: inTab('Session', (sheet) =>
		sheet.getByRole('button', { name: 'Download 2 files (zip)' })
	),
	transfers: inTab(
		'Session',
		(sheet) => sheet.getByRole('button', { name: 'Transfers', exact: true }),
		async (sheet) => {
			await sheet.getByRole('button', { name: 'Transfers', exact: true }).click();
			await expect.element(sheet.getByRole('region', { name: 'Transfers' })).toBeVisible();
		}
	),
	settings: inTab('Picture', (sheet) => sheet.getByRole('region', { name: 'Picture' })),
	display: inTab('Screen', (sheet) => sheet.getByRole('button', { name: 'Right' })),
	disconnect: inTab('Session', (sheet) => sheet.getByRole('button', { name: 'Disconnect' }))
};

function noReveal(): Promise<void> {
	return Promise.resolve();
}

/** Every action is there; the files-waiting notice shows, and once put away Download stays. */
async function offersEverything(
	where: Record<ChromeAction, Finder>,
	reveal: () => Promise<void>,
	afterPutAway: () => Promise<void>
): Promise<void> {
	const notice = page.getByRole('status').filter({ hasText: WAITING });
	await expect.element(notice, { timeout: 5000 }).toBeVisible();
	await expect.element(notice.getByRole('button', { name: 'Download', exact: true })).toBeVisible();
	for (const action of CHROME_ACTIONS) {
		await where[action].reach(reveal);
	}
	if (page.getByRole('group', { name: 'Session options' }).query() !== null) {
		await userEvent.keyboard('{Escape}');
	}
	await notice.getByRole('button', { name: 'Put away' }).click();
	await expect.element(notice).not.toBeInTheDocument();
	await afterPutAway();
}

async function downloadStaysOnBar(): Promise<void> {
	await revealBar();
	await expect.element(button('Download 2 files (zip)')).toBeVisible();
}

async function badgeOnButton(): Promise<void> {
	await expect
		.element(page.getByRole('button', { name: /^Session controls/ }))
		.toHaveAccessibleName('Session controls, 2 files copied on the machine');
}

describe('every desktop view offers the same features', () => {
	it('DP1, DP3: the tab', async () => {
		await openTab();
		await offersEverything(ON_BAR, noReveal, async () => {
			await expect.element(button('Download 2 files (zip)')).toBeVisible();
		});
	});

	it('DP1, DP3: full screen with a mouse', async () => {
		await openTab();
		await goFullScreen();
		await offersEverything(ON_BAR, revealBar, downloadStaysOnBar);
	});

	it('DP1, DP3: full screen on a tablet', async () => {
		touchDevice('tablet');
		await page.viewport(1024, 768);
		await openTab();
		await goFullScreen();
		await offersEverything(IN_SHEET, noReveal, badgeOnButton);
	});

	it('DP1, DP3: a phone', async () => {
		touchDevice('phone');
		await page.viewport(375, 667);
		await openTab();
		await expect.poll(() => document.fullscreenElement !== null).toBe(true);
		await offersEverything(IN_SHEET, noReveal, badgeOnButton);
	});

	it('DP1, DP3: the pop-out window with a mouse', async () => {
		await page.viewport(900, 600);
		await openWindow();
		await offersEverything(ON_BAR, revealBar, downloadStaysOnBar);
	});

	it('DP1, DP3: the pop-out window on touch', async () => {
		touchDevice('tablet');
		await page.viewport(900, 600);
		await openWindow();
		await offersEverything(IN_SHEET, noReveal, badgeOnButton);
	});

	it('DP2: a guest with control, in the page and in full screen, without file actions', async () => {
		await openGuest();
		for (const reveal of [noReveal, revealBar]) {
			if (reveal === revealBar) await goFullScreen();
			for (const action of CHROME_ACTIONS) {
				if (FILE_ACTIONS.includes(action)) {
					await ON_BAR[action].absent();
				} else {
					await ON_BAR[action].reach(reveal);
				}
			}
		}
		await expect.element(page.getByText(WAITING)).not.toBeInTheDocument();
	});
});

describe('notices and toasts over the screen', () => {
	it('DP5: a paused picture and a dropped connection show over the screen in full screen', async () => {
		const socket = await openTab();
		await goFullScreen();
		socket.receive(JSON.stringify({ type: 'stalled' }));
		await expect
			.element(stage().getByText('The picture is paused: frames were not getting through.'))
			.toBeVisible();
		socket.drop();
		await expect.element(stage().getByText('Reconnecting to the machine…')).toBeVisible();
	});

	it('DP5: the same notices show over the screen in the pop-out', async () => {
		await page.viewport(900, 600);
		const socket = await openWindow();
		socket.receive(JSON.stringify({ type: 'stalled' }));
		await expect
			.element(stage().getByText('The picture is paused: frames were not getting through.'))
			.toBeVisible();
	});

	it('DP6: a toast shows inside the browser full screen', async () => {
		await openTab();
		await goFullScreen();
		showToast('Copied from the machine', 'success');
		await expect
			.poll(() => document.fullscreenElement?.textContent ?? '')
			.toContain('Copied from the machine');
	});

	it('DP7: the pop-out shares the clipboard on focus and remembers the touch input choice', async () => {
		const status = await navigator.permissions.query({ name: 'geolocation' });
		Object.defineProperty(status, 'state', { value: 'granted', configurable: true });
		vi.spyOn(navigator.permissions, 'query').mockResolvedValue(status);
		vi.spyOn(navigator.clipboard, 'readText').mockResolvedValue('from this device');
		touchDevice('tablet');
		await page.viewport(900, 600);
		const socket = await openWindow();
		window.dispatchEvent(new Event('focus'));
		await expect
			.poll(() => socket.messages())
			.toContainEqual({ type: 'clipboard-sync', text: 'from this device' });
		const sheet = await sheetTab('Session');
		await sheet.getByRole('button', { name: 'Tap to click' }).click();
		expect(localStorage.getItem('bmuster.desktop.touchInput')).toBe('touch');
	});
});
