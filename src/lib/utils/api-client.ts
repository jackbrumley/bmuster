import type { z } from 'zod';

/**
 * The one way browser code talks to the server (AGENTS.md §6): JSON in, a
 * zod-checked reply out, and failures as a result rather than a throw.
 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string };

export async function apiRequest<Reply>(options: {
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	url: string;
	body: unknown;
	reply: z.ZodType<Reply>;
}): Promise<ApiResult<Reply>> {
	let response: Response;
	try {
		response = await fetch(options.url, {
			method: options.method,
			headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
			body: options.body === undefined ? null : JSON.stringify(options.body)
		});
	} catch {
		return { ok: false, message: 'Could not reach the server. Check your connection.' };
	}
	const json: unknown = await response.json().catch(() => undefined);
	if (!response.ok) {
		return { ok: false, message: messageFrom(json) ?? `The server said ${response.status}.` };
	}
	const parsed = options.reply.safeParse(json);
	if (!parsed.success) {
		return { ok: false, message: 'The server sent a reply this page does not understand.' };
	}
	return { ok: true, data: parsed.data };
}

function messageFrom(json: unknown): string | undefined {
	if (
		typeof json === 'object' &&
		json !== null &&
		'message' in json &&
		typeof json.message === 'string'
	) {
		return json.message;
	}
	return undefined;
}
