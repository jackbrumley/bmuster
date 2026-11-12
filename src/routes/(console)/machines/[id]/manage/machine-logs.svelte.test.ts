import { afterEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { AgentLogRecordView, LogPage } from '#lib/domain/logs/logs.ts';
import MachineLogs from './machine-logs.svelte';

const MACHINE_ID = '11111111-1111-4111-8111-111111111111';

function record(seq: number, overrides: Partial<AgentLogRecordView>): AgentLogRecordView {
	return {
		instance: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		seq,
		atIso: new Date(Date.UTC(2026, 10, 9, 10, 0, seq)).toISOString(),
		level: 'info',
		source: 'agent',
		target: 'bmuster_agent::sessions',
		text: `record ${seq}`,
		...overrides
	};
}

function reply(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function logPage(records: AgentLogRecordView[], newer: string): LogPage<AgentLogRecordView> {
	return { records, older: { kind: 'none' }, later: { kind: 'none' }, newer };
}

function urlOf(input: string | URL | Request): URL {
	return new URL(input instanceof Request ? input.url : input, 'https://bmuster.test');
}

/** Answers by URL, and remembers every request. */
function serve(handler: (url: URL, init: RequestInit | undefined) => Response) {
	const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
		return Promise.resolve(handler(urlOf(input), init));
	});
	vi.stubGlobal('fetch', fetch);
	return fetch;
}

function urls(fetch: ReturnType<typeof serve>): URL[] {
	return fetch.mock.calls.map(([input]) => urlOf(input));
}

function props(overrides: Partial<{ sendsLogs: boolean; verboseUntilIso: string | null }>) {
	return {
		machineId: MACHINE_ID,
		machineName: 'fedora-desk',
		sendsLogs: true,
		verboseUntilIso: null,
		...overrides
	};
}

describe('Manage tab: Logs panel (SPEC-AGENT-LOGS AL12)', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('AL12: reads the stored log newest first as plain text, and filters by level and source', async () => {
		const fetch = serve((url) =>
			url.searchParams.get('level') === 'warn'
				? reply(logPage([record(3, { level: 'warn', text: 'only warnings' })], 'n-3'))
				: reply(
						logPage(
							[
								record(2, { text: '<script>not markup</script>' }),
								record(1, { source: 'journal', target: 'journal', text: 'exit 208' })
							],
							'n-2'
						)
					)
		);
		const screen = await render(MachineLogs, props({}));
		await expect.element(screen.getByText(/<script>not markup<\/script>/)).toBeVisible();
		expect(screen.container.querySelector('pre script')).toBeNull();
		await expect.element(screen.getByText(/\[journal:journal\] exit 208/)).toBeVisible();
		expect(urls(fetch)[0]?.pathname).toBe(`/api/diagnostics/machines/${MACHINE_ID}/logs`);
		expect(urls(fetch)[0]?.searchParams.get('level')).toBe('info');

		await screen.getByRole('button', { name: 'Warnings' }).click();
		await expect.element(screen.getByText(/only warnings/)).toBeVisible();
		await screen.getByRole('button', { name: 'Journal' }).click();
		await expect.poll(() => urls(fetch).at(-1)?.searchParams.get('source')).toBe('journal');
		await screen.getByRole('button', { name: 'Last hour' }).click();
		await expect
			.poll(() => {
				const since = urls(fetch).at(-1)?.searchParams.get('since');
				return since === undefined || since === null ? Infinity : Date.now() - Date.parse(since);
			})
			.toBeLessThanOrEqual(60 * 60 * 1000 + 60_000);
	});

	it('AL12: Live follows new records every five seconds with the newer cursor', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		const fetch = serve((url) =>
			url.searchParams.get('cursor') === 'n-1'
				? reply(logPage([record(9, { text: 'arrived later' })], 'n-9'))
				: reply(logPage([record(1, { text: 'first read' })], 'n-1'))
		);
		const screen = await render(MachineLogs, props({}));
		await expect.element(screen.getByText(/first read/)).toBeVisible();
		vi.advanceTimersByTime(5000);
		expect(fetch).toHaveBeenCalledTimes(1);

		await screen.getByRole('checkbox', { name: 'Live' }).click();
		vi.advanceTimersByTime(5000);
		await expect.element(screen.getByText(/arrived later/)).toBeVisible();
		await expect.element(screen.getByText(/first read/)).toBeVisible();
		expect(urls(fetch).at(-1)?.searchParams.get('cursor')).toBe('n-1');
		vi.advanceTimersByTime(5000);
		await expect.poll(() => urls(fetch).at(-1)?.searchParams.get('cursor')).toBe('n-9');
	});

	it('AL12: Copy shown and Download write the shown records as text', async () => {
		serve(() => reply(logPage([record(1, { text: 'terminal failed with 208' })], 'n-1')));
		const clipboardWrite = vi.fn().mockResolvedValue(undefined);
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText: clipboardWrite }
		});
		const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:logs');
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
		const anchorClick = vi
			.spyOn(HTMLAnchorElement.prototype, 'click')
			.mockImplementation(() => undefined);

		const screen = await render(MachineLogs, props({}));
		await expect.element(screen.getByText(/terminal failed with 208/)).toBeVisible();
		await screen.getByRole('button', { name: 'Copy shown' }).click();
		await expect.poll(() => clipboardWrite.mock.calls.length).toBe(1);
		const copied = String(clipboardWrite.mock.calls[0]?.[0]);
		expect(copied).toContain('fedora-desk');
		expect(copied).toContain('INFO  [agent:bmuster_agent::sessions] terminal failed with 208');

		await screen.getByRole('button', { name: 'Download' }).click();
		await expect.poll(() => anchorClick.mock.calls.length).toBe(1);
		const file = createObjectUrl.mock.calls[0]?.[0];
		if (!(file instanceof Blob)) throw new Error('the download was not a Blob');
		await expect(file.text()).resolves.toContain('terminal failed with 208');
	});

	it('AL12: Verbose for 1 hour shows its countdown and Stop ends it', async () => {
		const untilIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		const fetch = serve((url, init) => {
			if (url.pathname.endsWith('/verbose')) {
				const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
				return reply(
					body !== null && typeof body === 'object' && 'kind' in body && body.kind === 'hour'
						? { untilIso, delivered: true }
						: { untilIso: null, delivered: true }
				);
			}
			return reply(logPage([], 'n-0'));
		});
		const screen = await render(MachineLogs, props({}));
		await screen.getByRole('button', { name: 'Verbose for 1 hour' }).click();
		await expect.element(screen.getByText(/Verbose, (59|60) min left/)).toBeVisible();
		await screen.getByRole('button', { name: 'Stop' }).click();
		await expect.element(screen.getByRole('button', { name: 'Verbose for 1 hour' })).toBeVisible();
		const posts = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
		expect(posts.map(([, init]) => init?.body)).toEqual([
			JSON.stringify({ kind: 'hour' }),
			JSON.stringify({ kind: 'stop' })
		]);
	});

	it('AL12: a page opened while verbose shows the time left', async () => {
		serve(() => reply(logPage([], 'n-0')));
		const screen = await render(
			MachineLogs,
			props({ verboseUntilIso: new Date(Date.now() + 90 * 60 * 1000).toISOString() })
		);
		await expect.element(screen.getByText(/Verbose, 1 h (29|30) min left/)).toBeVisible();
	});

	it('AL12: an older agent says it is too old; a failed read keeps what is shown', async () => {
		serve(() => reply(logPage([], 'n-0')));
		const old = await render(MachineLogs, props({ sendsLogs: false }));
		await expect
			.element(old.getByText('This agent is too old to send its logs; update it.'))
			.toBeVisible();
		await old.unmount();

		let fail = false;
		serve(() =>
			fail
				? reply({ message: 'Could not reach the server.' }, 503)
				: reply(logPage([record(1, { text: 'kept on failure' })], 'n-1'))
		);
		const screen = await render(MachineLogs, props({}));
		await expect.element(screen.getByText(/kept on failure/)).toBeVisible();
		fail = true;
		await screen.getByRole('button', { name: 'Errors' }).click();
		await expect
			.element(screen.getByText(/The records below are from the last read/))
			.toBeVisible();
		await expect.element(screen.getByText(/kept on failure/)).toBeVisible();
	});

	it('AL12: at phone width long lines wrap and nothing overflows', async () => {
		await page.viewport(390, 844);
		serve(() =>
			reply(
				logPage(
					[record(1, { text: `${'unbroken'.repeat(60)} https://example.com/${'x'.repeat(200)}` })],
					'n-1'
				)
			)
		);
		const screen = await render(MachineLogs, props({}));
		await expect.element(screen.getByLabelText('Agent log')).toBeVisible();
		const block = screen.container.querySelector('pre');
		if (block === null) throw new Error('no log block');
		expect(block.scrollWidth).toBeLessThanOrEqual(block.clientWidth);
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
	});

	it('L4: the first load waits under the veil, then shows the records', async () => {
		let answer: (response: Response) => void = () => undefined;
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof globalThis.fetch>(
				() =>
					new Promise<Response>((resolve) => {
						answer = resolve;
					})
			)
		);
		const screen = await render(MachineLogs, props({}));
		await expect.element(screen.getByRole('status').getByText('Reading the log')).toBeVisible();
		answer(reply(logPage([record(1, { text: 'first record' })], 'n-1')));
		await expect.element(screen.getByText(/first record/)).toBeVisible();
		await expect.element(screen.getByText('Reading the log')).not.toBeInTheDocument();
	});
});
