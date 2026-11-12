/**
 * The diagnostics reader behind `npm run diagnostics` (SPEC-AGENT-LOGS 4): plain text from the
 * read-only diagnostics endpoints, for the developer and the AI helping them.
 *
 * - BMUSTER_URL names the server; the token is read from ~/.config/bmuster/diagnostics-token,
 *   which must not be readable by anyone else (mode 0600), and is never printed.
 * - Everything it can do is a GET: the token cannot change anything.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import {
	checkLine,
	statsLine,
	stepLine,
	type MachineChecks,
	type MachineSessionView
} from '../../src/lib/domain/logs/checks.ts';
import {
	agentRecordLine,
	serverRecordLine,
	type LogOrder,
	type LogPage
} from '../../src/lib/domain/logs/logs.ts';
import { machineChecksSchema, machineSessionsSchema } from '../../src/lib/schemas/logs/checks.ts';
import { agentLogPageSchema, serverLogPageSchema } from '../../src/lib/schemas/logs/logs.ts';

export type CliIo = {
	env: Record<string, string | undefined>;
	home: string;
	platform: NodeJS.Platform;
	fetch: typeof globalThis.fetch;
	out: (line: string) => void;
	err: (line: string) => void;
	/** Waits before the next poll of --follow and watch; false stops (tests). */
	wait: (ms: number) => Promise<boolean>;
};

/** How often --follow and watch read again. */
const FOLLOW_EVERY_MS = 3000;

export const TOKEN_PATH = ['.config', 'bmuster', 'diagnostics-token'] as const;

const USAGE = `Usage: npm run diagnostics -- <command> [options]

  machines                       every machine: name, id, system, agent, online, last seen
  logs <name-or-id>              a machine's agent log, printed oldest first
  report <name-or-id>            a machine's latest inventory, display report and status
  server                         the server's own log, printed oldest first
  checks <name-or-id>            a machine's latest self-check results
  sessions <name-or-id>          a machine's sessions with their timelines and desktop figures
  watch <name-or-id>             follow a machine's log, check results and online state together

Every command:
  --json                         raw JSON instead of text (one JSON line per event when following)

Options for logs and server:
                                 without --since: the newest records, paging back with --cursor
  --since <1h|30m|2d|ISO time>   the records from this time forward, paging on with --cursor
  --until <ISO time>
  --level <error|warn|info|debug>
  --source <agent|helper|journal>   (logs)
  --area <sessions|agents|…>        (server)
  --limit <n>                    records a page, at most 2000 (default 200)
  --cursor <cursor>              the next page, from a "more" line (add it to the same command)
  --follow                       read every page from --since, then new records every 3 s

Options for sessions:
  --since <1h|30m|2d|ISO time>   (default: 7 days)
  --limit <n>                    at most 200 (default 20)

Needs BMUSTER_URL and a token in ~/.config/bmuster/diagnostics-token (mode 0600),
made on Settings → Diagnostics in the console.`;

class CliError extends Error {}

const machinesSchema = z.object({
	machines: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			osFamily: z.string(),
			agentVersion: z.string(),
			online: z.boolean(),
			lastSeenIso: z.string()
		})
	)
});

type Machine = z.infer<typeof machinesSchema>['machines'][number];

const messageSchema = z.object({ message: z.string() });

const UNIT_MS = new Map([
	['m', 60_000],
	['h', 3_600_000],
	['d', 86_400_000]
]);

function readToken(io: CliIo): string {
	const path = join(io.home, ...TOKEN_PATH);
	let mode: number;
	try {
		mode = statSync(path).mode;
	} catch {
		throw new CliError(
			`No token at ${path}. Make one on Settings → Diagnostics and save it there with mode 0600.`
		);
	}
	if (io.platform !== 'win32' && (mode & 0o077) !== 0) {
		throw new CliError(`${path} can be read by others; run: chmod 600 ${path}`);
	}
	const token = readFileSync(path, 'utf8').trim();
	if (!token.startsWith('bmd_')) {
		throw new CliError(`${path} does not hold a diagnostics token (bmd_…).`);
	}
	return token;
}

function serverUrl(io: CliIo): URL {
	const text = io.env['BMUSTER_URL'];
	if (text === undefined || text === '') {
		throw new CliError('Set BMUSTER_URL to the server address, e.g. https://bmuster.example.com');
	}
	try {
		return new URL(text);
	} catch {
		throw new CliError(`BMUSTER_URL=${text} is not an address.`);
	}
}

async function get<T>(
	io: CliIo,
	path: string,
	query: URLSearchParams,
	reply: z.ZodType<T>
): Promise<T> {
	const url = new URL(path, serverUrl(io));
	url.search = query.toString();
	const token = readToken(io);
	let response: Response;
	try {
		response = await io.fetch(url, { headers: { authorization: `Bearer ${token}` } });
	} catch (error) {
		throw new CliError(`Could not reach ${url.origin}: ${String(error)}`);
	}
	const body: unknown = await response.json().catch(() => undefined);
	if (!response.ok) {
		const refusal = messageSchema.safeParse(body);
		throw new CliError(
			`${response.status} from ${url.pathname}: ${refusal.success ? refusal.data.message : 'no reason given'}`
		);
	}
	const parsed = reply.safeParse(body);
	if (!parsed.success) {
		throw new CliError(`The server sent an unexpected reply from ${url.pathname}.`);
	}
	return parsed.data;
}

/** `1h`, `30m`, `2d` ago, or an ISO time as given. */
export function sinceTime(text: string, now: number): string {
	const relative = /^(\d+)([mhd])$/.exec(text);
	const unit = UNIT_MS.get(relative?.[2] ?? '');
	if (relative !== null && unit !== undefined) {
		return new Date(now - Number(relative[1]) * unit).toISOString();
	}
	if (Number.isNaN(Date.parse(text))) {
		throw new CliError(
			`--since ${text} is neither a time like 2026-11-09T10:00:00Z nor 1h, 30m or 2d.`
		);
	}
	return new Date(text).toISOString();
}

async function machines(io: CliIo): Promise<Machine[]> {
	return (await get(io, '/api/diagnostics/machines', new URLSearchParams(), machinesSchema))
		.machines;
}

async function machineId(io: CliIo, nameOrId: string | undefined): Promise<string> {
	if (nameOrId === undefined) {
		throw new CliError('Name the machine, by name or id.');
	}
	const all = await machines(io);
	const exact = all.find((machine) => machine.id === nameOrId);
	if (exact !== undefined) {
		return exact.id;
	}
	const named = all.filter((machine) => machine.name.toLowerCase() === nameOrId.toLowerCase());
	const [only, ...others] = named;
	if (only === undefined) {
		throw new CliError(`No machine called ${nameOrId}. Run: npm run diagnostics -- machines`);
	}
	if (others.length > 0) {
		throw new CliError(
			`More than one machine is called ${nameOrId}; use an id: ${named.map((machine) => machine.id).join(', ')}`
		);
	}
	return only.id;
}

/** The string options `parseArgs` read; each is absent when not given. */
type LogOptions = {
	since?: string | undefined;
	until?: string | undefined;
	level?: string | undefined;
	limit?: string | undefined;
	cursor?: string | undefined;
	source?: string | undefined;
	area?: string | undefined;
};

/**
 * The filters of a log read. Without --since it reads the newest records; with it, the records
 * from that time forward (`order=oldest`), so a busy hour cannot hide the start of the window.
 * The server keeps 7 days; every page names the cursor of the next.
 */
function logQuery(values: LogOptions, extra: 'source' | 'area', now: number): URLSearchParams {
	const query = new URLSearchParams();
	const optional: [string, string | undefined][] = [
		['since', values.since === undefined ? undefined : sinceTime(values.since, now)],
		['until', values.until],
		['level', values.level],
		['limit', values.limit],
		['cursor', values.cursor],
		[extra, extra === 'source' ? values.source : values.area]
	];
	for (const [name, value] of optional) {
		if (value !== undefined) query.set(name, value);
	}
	if (query.has('since')) query.set('order', 'oldest');
	return query;
}

type Output = 'text' | 'json';

/** Which way a read pages: a cursor carries its direction, else --since reads forward. */
function orderOf(query: URLSearchParams): LogOrder {
	const cursor = query.get('cursor');
	if (cursor?.startsWith('o-') === true) return 'newest';
	if (cursor?.startsWith('a-') === true) return 'oldest';
	return query.get('order') === 'oldest' ? 'oldest' : 'newest';
}

function moreLine<R>(page: LogPage<R>): string {
	const count = `${page.records.length} records`;
	if (page.older.kind === 'cursor') {
		return `(${count}; more before these: --cursor ${page.older.cursor})`;
	}
	if (page.later.kind === 'cursor') {
		return `(${count}; more after these: --cursor ${page.later.cursor})`;
	}
	return `(${count})`;
}

/** A page's records oldest first, whichever way it was read. */
function chronological<R>(page: LogPage<R>, order: LogOrder): R[] {
	return order === 'newest' ? [...page.records].reverse() : page.records;
}

function printPage<R>(
	io: CliIo,
	page: LogPage<R>,
	order: LogOrder,
	line: (record: R) => string,
	output: Output
): void {
	if (output === 'json') {
		io.out(JSON.stringify(page));
		return;
	}
	for (const record of chronological(page, order)) {
		io.out(line(record));
	}
	io.out(moreLine(page));
}

/** New records after a read, oldest first, one line (or JSON line) each. */
function printNew<R>(io: CliIo, page: LogPage<R>, line: (record: R) => string, output: Output) {
	for (const record of [...page.records].reverse()) {
		io.out(output === 'json' ? JSON.stringify(record) : line(record));
	}
}

/**
 * Reads a log page. With --follow it first reads on through every later page (from --since), then
 * every 3 s what arrived since, by the `newer` cursor.
 */
async function readLog<R>(
	io: CliIo,
	query: URLSearchParams,
	read: (query: URLSearchParams) => Promise<LogPage<R>>,
	line: (record: R) => string,
	follow: boolean,
	output: Output
): Promise<void> {
	const order = orderOf(query);
	let page = await read(query);
	while (follow && page.later.kind === 'cursor') {
		for (const record of page.records) {
			io.out(output === 'json' ? JSON.stringify(record) : line(record));
		}
		const next = new URLSearchParams(query);
		next.set('cursor', page.later.cursor);
		page = await read(next);
	}
	printPage(io, page, order, line, output);
	let newer = page.newer;
	while (follow && (await io.wait(FOLLOW_EVERY_MS))) {
		const next = new URLSearchParams(query);
		next.set('cursor', newer);
		const fresh = await read(next);
		printNew(io, fresh, line, output);
		newer = fresh.newer;
	}
}

function printChecks(io: CliIo, checks: MachineChecks, output: Output): void {
	if (output === 'json') {
		io.out(JSON.stringify(checks));
		return;
	}
	switch (checks.kind) {
		case 'unreported':
			io.out('This agent is too old to run checks (before 0.4.3).');
			return;
		case 'pending':
			io.out(`The agent has not finished its first checks yet (since ${checks.receivedIso}).`);
			return;
		case 'results':
			io.out(`Checks received ${checks.receivedIso}:`);
			for (const result of checks.results) {
				io.out(checkLine(result));
			}
	}
}

function sessionLines(session: MachineSessionView): string[] {
	const who =
		session.server.kind === 'known'
			? ` by ${session.server.userName}, ${session.server.ended.kind === 'running' ? 'running' : `ended ${session.server.ended.endedIso} (${session.server.ended.how})`}`
			: '';
	const lines = [`${session.startedIso} ${session.kind} ${session.sessionId}${who}`];
	if (session.timeline.kind === 'shipped') {
		lines.push(`  ${session.timeline.outcome}: ${session.timeline.reason}`);
		for (const step of session.timeline.steps) {
			lines.push(`    ${stepLine(step)}`);
		}
		if (session.timeline.omitted > 0) {
			lines.push(`    (${session.timeline.omitted} steps left out)`);
		}
	} else {
		lines.push('  no timeline from the agent');
	}
	for (const stats of [...session.stats].reverse()) {
		lines.push(`  ${stats.atIso} ${statsLine(stats)}`);
	}
	return lines;
}

/** Follows a machine's log, its check results and whether it is online, until stopped. */
async function watch(io: CliIo, id: string, query: URLSearchParams, output: Output): Promise<void> {
	const emit = (kind: string, text: string, value: unknown) => {
		io.out(output === 'json' ? JSON.stringify({ kind, value }) : text);
	};
	let online: boolean | undefined;
	let checked = '';
	let newer: string | undefined;
	do {
		const machine = (await machines(io)).find((found) => found.id === id);
		if (machine !== undefined && machine.online !== online) {
			online = machine.online;
			emit('online', `-- ${machine.name} is ${online ? 'online' : 'offline'}`, online);
		}
		const checks = await get(
			io,
			`/api/diagnostics/machines/${id}/checks`,
			new URLSearchParams(),
			machineChecksSchema
		);
		const received = checks.kind === 'unreported' ? 'unreported' : checks.receivedIso;
		if (received !== checked) {
			checked = received;
			if (output === 'json') emit('checks', '', checks);
			else printChecks(io, checks, output);
		}
		// Watch starts from the newest records, whatever --since says about where they begin.
		const logQuery = new URLSearchParams(query);
		logQuery.delete('order');
		if (newer !== undefined) logQuery.set('cursor', newer);
		const page = await get(
			io,
			`/api/diagnostics/machines/${id}/logs`,
			logQuery,
			agentLogPageSchema
		);
		for (const record of [...page.records].reverse()) {
			emit('log', agentRecordLine(record), record);
		}
		newer = page.newer;
	} while (await io.wait(FOLLOW_EVERY_MS));
}

export async function runDiagnostics(args: string[], io: CliIo, now: number): Promise<number> {
	try {
		const { values, positionals } = parseArgs({
			args,
			allowPositionals: true,
			options: {
				since: { type: 'string' },
				until: { type: 'string' },
				level: { type: 'string' },
				source: { type: 'string' },
				area: { type: 'string' },
				limit: { type: 'string' },
				cursor: { type: 'string' },
				follow: { type: 'boolean' },
				json: { type: 'boolean' },
				help: { type: 'boolean' }
			}
		});
		const [command, target] = positionals;
		const output: Output = values.json === true ? 'json' : 'text';
		const follow = values.follow === true;
		if (values.help === true || command === undefined) {
			io.out(USAGE);
			return command === undefined && values.help !== true ? 1 : 0;
		}
		switch (command) {
			case 'machines': {
				const all = await machines(io);
				if (output === 'json') {
					io.out(JSON.stringify(all));
					return 0;
				}
				for (const machine of all) {
					io.out(
						[
							machine.name,
							machine.id,
							machine.osFamily,
							`v${machine.agentVersion}`,
							machine.online ? 'online' : 'offline',
							`last seen ${machine.lastSeenIso}`
						].join('  ')
					);
				}
				return 0;
			}
			case 'logs': {
				const id = await machineId(io, target);
				await readLog(
					io,
					logQuery(values, 'source', now),
					(query) => get(io, `/api/diagnostics/machines/${id}/logs`, query, agentLogPageSchema),
					agentRecordLine,
					follow,
					output
				);
				return 0;
			}
			case 'report': {
				const id = await machineId(io, target);
				const report = await get(
					io,
					`/api/diagnostics/machines/${id}/report`,
					new URLSearchParams(),
					z.unknown()
				);
				io.out(output === 'json' ? JSON.stringify(report) : JSON.stringify(report, null, 2));
				return 0;
			}
			case 'server': {
				await readLog(
					io,
					logQuery(values, 'area', now),
					(query) => get(io, '/api/diagnostics/server/logs', query, serverLogPageSchema),
					serverRecordLine,
					follow,
					output
				);
				return 0;
			}
			case 'checks': {
				const id = await machineId(io, target);
				const checks = await get(
					io,
					`/api/diagnostics/machines/${id}/checks`,
					new URLSearchParams(),
					machineChecksSchema
				);
				printChecks(io, checks, output);
				return 0;
			}
			case 'sessions': {
				const id = await machineId(io, target);
				const query = new URLSearchParams({ since: sinceTime(values.since ?? '7d', now) });
				if (values.limit !== undefined) query.set('limit', values.limit);
				const { sessions } = await get(
					io,
					`/api/diagnostics/machines/${id}/sessions`,
					query,
					machineSessionsSchema
				);
				if (output === 'json') {
					io.out(JSON.stringify(sessions));
					return 0;
				}
				for (const session of [...sessions].reverse()) {
					for (const line of sessionLines(session)) io.out(line);
				}
				io.out(`(${sessions.length} sessions)`);
				return 0;
			}
			case 'watch': {
				const id = await machineId(io, target);
				await watch(io, id, logQuery(values, 'source', now), output);
				return 0;
			}
			default:
				throw new CliError(`Unknown command ${command}.\n\n${USAGE}`);
		}
	} catch (error) {
		if (error instanceof CliError || error instanceof TypeError) {
			io.err(`diagnostics: ${error.message}`);
			return 1;
		}
		throw error;
	}
}
