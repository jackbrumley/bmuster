import type { RequestEvent } from '@sveltejs/kit';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { filesChannels } from '#lib/server/services/sessions/files-channel.ts';
import type { FilesContext, FilesOutcome } from '#lib/server/services/sessions/files.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';

/** What every files route passes to the files service (SPEC-FILES). */
export function filesContext(event: RequestEvent<{ id: string }>, user: ConsoleUser): FilesContext {
	return {
		database,
		relay: sessionRelay(),
		channels: filesChannels(),
		secretsKey: env.secretsKey,
		user,
		machineId: event.params.id,
		ip: event.getClientAddress(),
		now: Date.now()
	};
}

/** The value as JSON, or the refusal's status and message. */
export function filesReply<T>(outcome: FilesOutcome<T>): Response {
	return outcome.kind === 'ok'
		? Response.json(outcome.value)
		: Response.json({ message: outcome.message }, { status: outcome.status });
}

/** A query parameter that must be there. */
export function queryValue(event: RequestEvent, name: string): string {
	return event.url.searchParams.get(name) ?? '';
}
