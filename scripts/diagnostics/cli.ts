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
import { agentRecordLine, serverRecordLine, type LogPage } from '../../src/lib/domain/logs/logs.ts';
import { agentLogPageSchema, serverLogPageSchema } from '../../src/lib/schemas/logs/logs.ts';

export type CliIo = {
	env: Record<string, string | undefined>;
	home: string;
	platform: NodeJS.Platform;
	fetch: typeof globalThis.fetch;
	out: (line: string) => void;
	err: (line: string) => void;
};

export const TOKEN_PATH = ['.config', 'bmuster', 'diagnostics-token'] as const;

const USAGE = `Usage: npm run diagnostics -- <command> [options]

  machines                       every machine: name, id, system, agent, online, last seen
  logs <name-or-id>              a machine's agent log, oldest first
  report <name-or-id>            a machine's latest inventory, display report and status
  server                         the server's own log, oldest first

Options for logs and server:
  --since <1h|30m|2d|ISO time>   from this long ago or this time (default: 1h)
  --until <ISO time>
  --level <error|warn|info|debug>
  --source <agent|helper|journal>   (logs)
  --area <sessions|agents|…>        (server)
  --limit <n>                    at most 2000 (default 200)
  --cursor <cursor>              continue from a "more" line

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

function logQuery(values: LogOptions, extra: 'source' | 'area', now: number): URLSearchParams {
	const query = new URLSearchParams({ since: sinceTime(values.since ?? '1h', now) });
	const optional: [string, string | undefined][] = [
		['until', values.until],
		['level', values.level],
		['limit', values.limit],
		['cursor', values.cursor],
		[extra, extra === 'source' ? values.source : values.area]
	];
	for (const [name, value] of optional) {
		if (value !== undefined) query.set(name, value);
	}
	return query;
}

function printPage<R>(io: CliIo, page: LogPage<R>, line: (record: R) => string): void {
	for (const record of [...page.records].reverse()) {
		io.out(line(record));
	}
	io.out(
		page.older.kind === 'cursor'
			? `(${page.records.length} records; more before these: --cursor ${page.older.cursor})`
			: `(${page.records.length} records)`
	);
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
				help: { type: 'boolean' }
			}
		});
		const [command, target] = positionals;
		if (values.help === true || command === undefined) {
			io.out(USAGE);
			return command === undefined && values.help !== true ? 1 : 0;
		}
		switch (command) {
			case 'machines':
				for (const machine of await machines(io)) {
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
			case 'logs': {
				const id = await machineId(io, target);
				const page = await get(
					io,
					`/api/diagnostics/machines/${id}/logs`,
					logQuery(values, 'source', now),
					agentLogPageSchema
				);
				printPage(io, page, agentRecordLine);
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
				io.out(JSON.stringify(report, null, 2));
				return 0;
			}
			case 'server': {
				const page = await get(
					io,
					'/api/diagnostics/server/logs',
					logQuery(values, 'area', now),
					serverLogPageSchema
				);
				printPage(io, page, serverRecordLine);
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
