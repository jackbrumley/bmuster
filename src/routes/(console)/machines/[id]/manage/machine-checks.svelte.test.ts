import { describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { CheckResultView, MachineChecks as Checks } from '#lib/domain/logs/checks.ts';
import MachineChecks from './machine-checks.svelte';

const MACHINE_ID = '11111111-1111-4111-8111-111111111111';
const RECEIVED = new Date(Date.now() - 120_000).toISOString();

function result(id: string, status: CheckResultView['status'], detail: string): CheckResultView {
	return { id, title: `Check ${id}`, status, detail, durationMs: 15, checkedAtIso: RECEIVED };
}

function reply(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function urlOf(input: string | URL | Request): URL {
	return new URL(input instanceof Request ? input.url : input, 'https://bmuster.test');
}

function serve(handler: (url: URL, init: RequestInit | undefined) => Response) {
	const fetch = vi.fn<typeof globalThis.fetch>((input, init) =>
		Promise.resolve(handler(urlOf(input), init))
	);
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

const RESULTS: Checks = {
	kind: 'results',
	receivedIso: RECEIVED,
	results: [
		result('systemd-run', 'pass', 'Ran /bin/true as a transient unit.'),
		result(
			'terminal-pty',
			'fail',
			'bmuster-check-pty.service: Failed to set up standard input: Permission denied'
		),
		result('x11-display', 'not-applicable', 'The screen is a Wayland session.')
	]
};

describe('Manage tab: Checks card (SPEC-DIAGNOSTICS D10)', () => {
	it('D10: lists pass, fail with the reason, and not applicable', async () => {
		serve(() => reply(RESULTS));
		const screen = await render(MachineChecks, { machineId: MACHINE_ID, machineName: 'fedora' });
		await expect.element(screen.getByText('Check terminal-pty')).toBeVisible();
		await expect
			.element(screen.getByText(/Failed to set up standard input: Permission denied/))
			.toBeVisible();
		await expect.element(screen.getByText('Not applicable')).toBeVisible();
		await expect.element(screen.getByText(/1 passed, 1 failed · 2 min ago/)).toBeVisible();
	});

	it('D10: says when the agent is too old, or has not run them yet', async () => {
		serve(() => reply({ kind: 'unreported' }));
		const old = await render(MachineChecks, { machineId: MACHINE_ID, machineName: 'fedora' });
		await expect
			.element(old.getByText('This agent is too old to run checks; update it.'))
			.toBeVisible();
		await old.unmount();
		serve(() => reply({ kind: 'pending', receivedIso: RECEIVED }));
		const pending = await render(MachineChecks, { machineId: MACHINE_ID, machineName: 'fedora' });
		await expect.element(pending.getByText(/a minute after it starts/)).toBeVisible();
	});

	it('D10: Run checks asks the server, then shows its refusal as a toast', async () => {
		let posts = 0;
		const fetch = serve((url, init) => {
			if (init?.method === 'POST') {
				posts += 1;
				return posts === 1
					? reply({ requested: true })
					: reply(
							{ message: 'Checks were asked for less than a minute ago; try again in 50 s.' },
							429
						);
			}
			return reply(RESULTS);
		});
		const screen = await render(MachineChecks, { machineId: MACHINE_ID, machineName: 'fedora' });
		await screen.getByRole('button', { name: 'Run checks' }).click();
		await expect.poll(() => posts).toBe(1);
		const post = fetch.mock.calls.find(([, init]) => init?.method === 'POST');
		expect(urlOf(post?.[0] ?? '').pathname).toBe(`/api/machines/${MACHINE_ID}/checks`);
		expect(post?.[1]?.body).toBeNull();
		await expect.element(screen.getByRole('button', { name: 'Running…' })).toBeVisible();
	});

	it('D10: at phone width long details wrap and nothing overflows', async () => {
		await page.viewport(390, 844);
		serve(() =>
			reply({
				...RESULTS,
				results: [result('audit', 'fail', `${'denied'.repeat(80)} /dev/pts/${'9'.repeat(120)}`)]
			})
		);
		const screen = await render(MachineChecks, { machineId: MACHINE_ID, machineName: 'fedora' });
		await expect.element(screen.getByText('Check audit')).toBeVisible();
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
	});
});
