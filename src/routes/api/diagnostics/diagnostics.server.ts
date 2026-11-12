import type { DiagnosticsReader } from '#lib/server/guards/route.ts';
import type { Reader } from '#lib/server/services/logs/diagnostics-reads.ts';

/** Shared by the read-only diagnostics endpoints (SPEC-AGENT-LOGS 4). */

/** Logs and reports are never cached on the way. */
export function noStore(body: unknown): Response {
	return Response.json(body, { headers: { 'cache-control': 'no-store' } });
}

/** Who read, for the audit entry: the console, or a token by name. */
export function readerOf(reader: DiagnosticsReader): Reader {
	switch (reader.kind) {
		case 'session':
			return { userId: reader.user.id, via: 'console' };
		case 'token':
			return { userId: reader.user.id, via: `token ${reader.tokenName}` };
	}
}

/** The query parameters both log reads share, each as its text or null. */
export function windowParams(url: URL): {
	since: string | null;
	until: string | null;
	order: string | null;
	level: string | null;
	cursor: string | null;
	limit: string | null;
} {
	const get = (name: string): string | null => url.searchParams.get(name);
	return {
		since: get('since'),
		until: get('until'),
		order: get('order'),
		level: get('level'),
		cursor: get('cursor'),
		limit: get('limit')
	};
}
