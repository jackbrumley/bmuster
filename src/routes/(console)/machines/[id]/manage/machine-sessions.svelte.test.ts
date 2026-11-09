import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { MachineSessionView } from '#lib/domain/logs/checks.ts';
import MachineSessions from './machine-sessions.svelte';

const MACHINE_ID = '11111111-1111-4111-8111-111111111111';
const STARTED = new Date(Date.now() - 5 * 60_000).toISOString();

function reply(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function serve(body: unknown, status = 200) {
	const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(reply(body, status)));
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

const DESKTOP: MachineSessionView = {
	sessionId: 'a1',
	kind: 'desktop',
	startedIso: STARTED,
	server: {
		kind: 'known',
		userName: 'Jack',
		openedIso: STARTED,
		ended: { kind: 'ended', endedIso: STARTED, how: 'Closed by the viewer' }
	},
	timeline: {
		kind: 'shipped',
		outcome: 'ended',
		reason: 'closed',
		startedIso: STARTED,
		steps: [
			{ t: 0, step: 'ticket-checked', detail: '' },
			{ t: 310, step: 'backend', detail: 'kms' },
			{ t: 420, step: 'first-frame', detail: '1920x1080' }
		],
		omitted: 0
	},
	stats: [
		{
			atIso: STARTED,
			intervalMs: 30_000,
			framesSent: 600,
			captureMsAvg: 4.5,
			encodeMsAvg: 7.25,
			bytesPerSecond: 256_000,
			droppedFrames: 3,
			tiles: 9000,
			backend: 'kms'
		}
	]
};

const TERMINAL: MachineSessionView = {
	sessionId: 'b2',
	kind: 'terminal',
	startedIso: STARTED,
	server: { kind: 'unknown' },
	timeline: {
		kind: 'shipped',
		outcome: 'failed',
		reason: 'exit 208: Failed to set up standard input: Permission denied',
		startedIso: STARTED,
		steps: [{ t: 12, step: 'unit-started', detail: 'bmuster-terminal-b2.service' }],
		omitted: 4
	},
	stats: []
};

describe('Manage tab: Sessions list (SPEC-DIAGNOSTICS D10)', () => {
	it('D10: shows each session with who, outcome, timeline steps and desktop figures', async () => {
		const fetch = serve({ sessions: [DESKTOP, TERMINAL] });
		const screen = await render(MachineSessions, { machineId: MACHINE_ID });
		await expect.element(screen.getByText('Closed by the viewer')).toBeVisible();
		await expect.element(screen.getByText(/Jack · 5 min ago/)).toBeVisible();
		await expect
			.element(screen.getByText(/Failed: exit 208: Failed to set up standard input/))
			.toBeVisible();
		await expect
			.element(screen.getByText(/kms: 600 frames in 30 s, capture 4.5 ms, encode 7.3 ms/))
			.toBeVisible();
		await screen.getByText('Timeline, 3 steps').click();
		await expect.element(screen.getByText('+310 ms backend kms')).toBeVisible();
		await expect.element(screen.getByText('4 steps left out of the middle.')).toBeInTheDocument();
		const [input] = fetch.mock.calls[0] ?? [''];
		const url = new URL(input instanceof Request ? input.url : input, 'https://bmuster.test');
		expect(url.pathname).toBe(`/api/diagnostics/machines/${MACHINE_ID}/sessions`);
	});

	it('D10: says so when there are none, and shows a refusal', async () => {
		serve({ sessions: [] });
		const none = await render(MachineSessions, { machineId: MACHINE_ID });
		await expect.element(none.getByText(/No sessions in the last 7 days/)).toBeVisible();
		await none.unmount();
		serve({ message: 'Only admins can read diagnostics.' }, 403);
		const refused = await render(MachineSessions, { machineId: MACHINE_ID });
		await expect.element(refused.getByText('Only admins can read diagnostics.')).toBeVisible();
	});

	it('D10: at phone width long reasons wrap and nothing overflows', async () => {
		await page.viewport(390, 844);
		serve({
			sessions: [
				{
					...TERMINAL,
					timeline: {
						...TERMINAL.timeline,
						reason: 'unbroken'.repeat(60),
						steps: [{ t: 1, step: 'unit-started', detail: 'x'.repeat(300) }]
					}
				}
			]
		});
		const screen = await render(MachineSessions, { machineId: MACHINE_ID });
		await screen.getByText('Timeline, 1 steps').click();
		await expect.element(screen.getByRole('list', { name: 'Timeline' })).toBeVisible();
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
	});
});
