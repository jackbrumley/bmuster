import { SvelteSet } from 'svelte/reactivity';
import type { LiveEvent } from '#lib/domain/commands/assistant-runs.ts';
import { LIVE_EVENT, liveEventSchema } from '#lib/schemas/commands/approvals.ts';
import { apiEvents } from '#lib/utils/api-client.ts';

/**
 * The console's live channel in the browser (`GET /api/live`, SPEC-MCP 10.3, M26): one stream per
 * tab, opened by the console frame. It keeps the Approvals count up to date and hands each event
 * to whoever listens (the frame's notice, the Approvals page).
 */

export const live = $state<{ pending: number | null }>({ pending: null });

const listeners = new SvelteSet<(event: LiveEvent) => void>();

/** Hears every event until the returned function is called. */
export function onLiveEvent(listener: (event: LiveEvent) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Opens the stream; the returned function closes it. */
export function connectLive(url: string): () => void {
	return apiEvents({
		url,
		event: LIVE_EVENT,
		reply: liveEventSchema,
		onEvent: (event) => {
			live.pending = event.pending;
			for (const listener of listeners) {
				listener(event);
			}
		},
		onReconnect: () => undefined,
		onFailure: () => undefined
	});
}
