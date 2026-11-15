import type { RequestEvent } from '@sveltejs/kit';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';
import {
	sessionFilesChannels,
	type Outcome,
	type SessionFilesContext
} from '#lib/server/services/sessions/session-files.ts';
import { transferStore } from '#lib/server/services/sessions/session-files-transfers.ts';

/** What every session-files route passes to the service (SPEC-SESSION-FILES 4.8). */
export function sessionFilesContext(
	event: RequestEvent<{ id: string }>,
	user: ConsoleUser
): SessionFilesContext {
	return {
		database,
		relay: sessionRelay(),
		channels: sessionFilesChannels(),
		transfers: transferStore(),
		secretsKey: env.secretsKey,
		user,
		machineId: event.params.id,
		ip: event.getClientAddress(),
		now: Date.now()
	};
}

/** The value as JSON, or the refusal's status and message. */
export function sessionFilesReply<T>(outcome: Outcome<T>): Response {
	return outcome.kind === 'ok'
		? Response.json(outcome.value)
		: Response.json({ message: outcome.message }, { status: outcome.status });
}
