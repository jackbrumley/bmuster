import type { z } from 'zod';

/**
 * The one way browser code talks to the server (AGENTS.md §6): JSON in, a
 * zod-checked reply out, and failures as a result rather than a throw.
 * `status` is the HTTP status of a refusal, or 0 when the server could not
 * be reached (worth trying again).
 */
export type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string; status: number };

const UNREACHABLE = 'Could not reach the server. Check your connection.';

export async function apiRequest<Reply>(options: {
	method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
	url: string;
	body: unknown;
	reply: z.ZodType<Reply>;
	signal?: AbortSignal;
}): Promise<ApiResult<Reply>> {
	let response: Response;
	try {
		const request: RequestInit = {
			method: options.method,
			headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
			body: options.body === undefined ? null : JSON.stringify(options.body)
		};
		if (options.signal !== undefined) request.signal = options.signal;
		response = await fetch(options.url, request);
	} catch {
		return { ok: false, message: UNREACHABLE, status: 0 };
	}
	const json: unknown = await response.json().catch(() => undefined);
	return resultOf(response.status, json, options.reply);
}

/**
 * Sends raw bytes with `PUT` (an upload piece), reporting progress as it
 * goes; `signal` stops it. XMLHttpRequest, because fetch reports no upload
 * progress.
 */
export function apiUpload<Reply>(options: {
	url: string;
	body: Blob;
	reply: z.ZodType<Reply>;
	onProgress: (sentBytes: number) => void;
	signal: AbortSignal;
}): Promise<ApiResult<Reply>> {
	return new Promise((resolve) => {
		const request = new XMLHttpRequest();
		request.open('PUT', options.url);
		request.setRequestHeader('content-type', 'application/octet-stream');
		request.upload.addEventListener('progress', (event) => {
			options.onProgress(event.loaded);
		});
		request.addEventListener('load', () => {
			let json: unknown;
			try {
				json = JSON.parse(request.responseText);
			} catch {
				json = undefined;
			}
			resolve(resultOf(request.status, json, options.reply));
		});
		request.addEventListener('error', () => {
			resolve({ ok: false, message: UNREACHABLE, status: 0 });
		});
		request.addEventListener('abort', () => {
			resolve({ ok: false, message: 'Stopped.', status: 0 });
		});
		if (options.signal.aborted) {
			resolve({ ok: false, message: 'Stopped.', status: 0 });
			return;
		}
		options.signal.addEventListener('abort', () => {
			request.abort();
		});
		request.send(options.body);
	});
}

/**
 * Listens to a server-sent event stream (EventSource): each `event` is parsed
 * with its zod contract (anything else is ignored). The browser reconnects a
 * dropped stream by itself; `onReconnect` runs when it is back, since events
 * sent meanwhile were missed. `onFailure` runs when the stream cannot be had
 * at all (no EventSource, or a refusal such as a signed-out session), so the
 * caller can fall back to polling. Returns the stop.
 */
export function apiEvents<Event>(options: {
	url: string;
	event: string;
	reply: z.ZodType<Event>;
	onEvent: (event: Event) => void;
	onReconnect: () => void;
	onFailure: () => void;
}): () => void {
	if (typeof EventSource === 'undefined') {
		options.onFailure();
		return () => undefined;
	}
	const source = new EventSource(options.url);
	let opened = false;
	source.addEventListener('open', () => {
		if (opened) {
			options.onReconnect();
		}
		opened = true;
	});
	source.addEventListener(options.event, (message) => {
		let json: unknown;
		try {
			json = JSON.parse(String(message.data));
		} catch {
			return;
		}
		const parsed = options.reply.safeParse(json);
		if (parsed.success) {
			options.onEvent(parsed.data);
		}
	});
	source.addEventListener('error', () => {
		if (source.readyState === EventSource.CLOSED) {
			options.onFailure();
		}
	});
	return () => {
		source.close();
	};
}

function resultOf<Reply>(status: number, json: unknown, reply: z.ZodType<Reply>): ApiResult<Reply> {
	if (status < 200 || status > 299) {
		return { ok: false, message: messageFrom(json) ?? `The server said ${status}.`, status };
	}
	const parsed = reply.safeParse(json);
	if (!parsed.success) {
		return { ok: false, message: 'The server sent a reply this page does not understand.', status };
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
