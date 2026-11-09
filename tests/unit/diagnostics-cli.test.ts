import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
	runDiagnostics,
	sinceTime,
	TOKEN_PATH,
	type CliIo
} from '../../scripts/diagnostics/cli.ts';

const TOKEN = `bmd_${'A'.repeat(43)}`;
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const MACHINE = {
	id: '11111111-1111-4111-8111-111111111111',
	name: 'fedora-desk',
	osFamily: 'linux',
	agentVersion: '0.4.0',
	online: true,
	lastSeenIso: '2026-11-09T11:59:00.000Z'
};

function home(mode: number | null): string {
	const dir = mkdtempSync(join(tmpdir(), 'bmuster-cli-'));
	if (mode !== null) {
		const path = join(dir, ...TOKEN_PATH);
		mkdirSync(join(dir, '.config', 'bmuster'), { recursive: true });
		writeFileSync(path, `${TOKEN}\n`);
		chmodSync(path, mode);
	}
	return dir;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function io(homeDir: string, routes: (url: URL) => Response) {
	const out: string[] = [];
	const err: string[] = [];
	const fetch = vi.fn<typeof globalThis.fetch>((input) =>
		Promise.resolve(routes(new URL(input instanceof Request ? input.url : String(input))))
	);
	const value: CliIo = {
		env: { BMUSTER_URL: 'https://bmuster.example.com' },
		home: homeDir,
		platform: 'linux',
		fetch,
		out: (line) => out.push(line),
		err: (line) => err.push(line)
	};
	return { io: value, out, err, fetch };
}

const routes = (url: URL): Response => {
	switch (url.pathname) {
		case '/api/diagnostics/machines':
			return json({ machines: [MACHINE] });
		case `/api/diagnostics/machines/${MACHINE.id}/logs`:
			return json({
				records: [
					{
						instance: 'i',
						seq: 2,
						atIso: '2026-11-09T11:00:02.000Z',
						level: 'warn',
						source: 'journal',
						target: 'journal',
						text: 'bmuster-terminal-1.service: exit 208'
					},
					{
						instance: 'i',
						seq: 1,
						atIso: '2026-11-09T11:00:01.000Z',
						level: 'info',
						source: 'agent',
						target: 'bmuster_agent::sessions',
						text: 'Session started.'
					}
				],
				older: { kind: 'cursor', cursor: 'o-1-1' },
				newer: 'n-2'
			});
		case `/api/diagnostics/machines/${MACHINE.id}/report`:
			return json({ machine: { id: MACHINE.id }, inventory: { display: { kind: 'linux' } } });
		case '/api/diagnostics/server/logs':
			return json({
				records: [
					{
						instance: 's',
						seq: 1,
						atIso: '2026-11-09T11:30:00.000Z',
						level: 'info',
						area: 'agents',
						machineId: MACHINE.id,
						text: 'Live socket opened.'
					}
				],
				older: { kind: 'none' },
				newer: 'n-1'
			});
		default:
			return json({ message: 'No such endpoint.' }, 404);
	}
};

describe('npm run diagnostics (SPEC-AGENT-LOGS AL13)', () => {
	it('AL13: prints machines, sending the token as a bearer header', async () => {
		const run = io(home(0o600), routes);
		expect(await runDiagnostics(['machines'], run.io, NOW)).toBe(0);
		expect(run.out).toEqual([
			`fedora-desk  ${MACHINE.id}  linux  v0.4.0  online  last seen 2026-11-09T11:59:00.000Z`
		]);
		const init = run.fetch.mock.calls[0]?.[1];
		expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
		expect(run.out.join('\n')).not.toContain(TOKEN);
	});

	it('AL13: prints a machine log by name, oldest first, with its filters', async () => {
		const run = io(home(0o600), routes);
		expect(
			await runDiagnostics(['logs', 'Fedora-Desk', '--level', 'warn', '--since', '2h'], run.io, NOW)
		).toBe(0);
		expect(run.out).toEqual([
			'2026-11-09T11:00:01.000Z INFO  [agent:bmuster_agent::sessions] Session started.',
			'2026-11-09T11:00:02.000Z WARN  [journal:journal] bmuster-terminal-1.service: exit 208',
			'(2 records; more before these: --cursor o-1-1)'
		]);
		const logsCall = run.fetch.mock.calls
			.map(([input]) => new URL(input instanceof Request ? input.url : input))
			.find((url) => url.pathname.endsWith('/logs'));
		expect(logsCall?.searchParams.get('level')).toBe('warn');
		expect(logsCall?.searchParams.get('since')).toBe(new Date(NOW - 2 * 3_600_000).toISOString());
	});

	it('AL13: prints a report and the server log', async () => {
		const report = io(home(0o600), routes);
		expect(await runDiagnostics(['report', MACHINE.id], report.io, NOW)).toBe(0);
		expect(JSON.parse(report.out.join('\n'))).toEqual({
			machine: { id: MACHINE.id },
			inventory: { display: { kind: 'linux' } }
		});
		const server = io(home(0o600), routes);
		expect(await runDiagnostics(['server', '--area', 'agents'], server.io, NOW)).toBe(0);
		expect(server.out[0]).toBe(
			`2026-11-09T11:30:00.000Z INFO  [agents ${MACHINE.id}] Live socket opened.`
		);
	});

	it('AL13: refuses a missing or readable token file, a missing URL and an unknown machine', async () => {
		const missing = io(home(null), routes);
		expect(await runDiagnostics(['machines'], missing.io, NOW)).toBe(1);
		expect(missing.err[0]).toMatch(/No token at .*diagnostics-token/);

		const open = io(home(0o644), routes);
		expect(await runDiagnostics(['machines'], open.io, NOW)).toBe(1);
		expect(open.err[0]).toMatch(/can be read by others; run: chmod 600/);
		expect(open.fetch).not.toHaveBeenCalled();

		const noUrl = io(home(0o600), routes);
		noUrl.io.env = {};
		expect(await runDiagnostics(['machines'], noUrl.io, NOW)).toBe(1);
		expect(noUrl.err[0]).toMatch(/Set BMUSTER_URL/);

		const unknown = io(home(0o600), routes);
		expect(await runDiagnostics(['logs', 'nowhere'], unknown.io, NOW)).toBe(1);
		expect(unknown.err[0]).toMatch(/No machine called nowhere/);

		const refused = io(home(0o600), () =>
			json({ message: 'This diagnostics token is not valid.' }, 401)
		);
		expect(await runDiagnostics(['server'], refused.io, NOW)).toBe(1);
		expect(refused.err[0]).toMatch(/401 .* This diagnostics token is not valid\./);
	});

	it('AL13: reads relative and absolute times', () => {
		expect(sinceTime('30m', NOW)).toBe(new Date(NOW - 30 * 60_000).toISOString());
		expect(sinceTime('2d', NOW)).toBe(new Date(NOW - 2 * 86_400_000).toISOString());
		expect(sinceTime('2026-11-09T10:00:00Z', NOW)).toBe('2026-11-09T10:00:00.000Z');
		expect(() => sinceTime('yesterday', NOW)).toThrow(/neither a time/);
	});
});
