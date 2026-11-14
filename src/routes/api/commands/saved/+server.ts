import { savedCommandWriteSchema } from '#lib/schemas/commands/saved-commands.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { createSavedCommand } from '#lib/server/services/commands/saved-command-admin.ts';
import { savedCommandsFor } from '#lib/server/services/commands/saved-command-runs.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import { commandContext } from '../command-context.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/commands/saved: the saved commands this person may see (SPEC-SAVED-COMMANDS SC1). */
export const GET: RequestHandler = route.user((_event, { user }) =>
	Response.json({ commands: savedCommandsFor(database, user) })
);

/**
 * POST /api/commands/saved: a new saved command (SC2–SC5). Security work: admins only, behind the
 * recent sign-in check, audited.
 */
export const POST: RequestHandler = route.admin(async (event, session) => {
	const parsed = savedCommandWriteSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const written = await createSavedCommand(commandContext(event, session), parsed.data);
	return written.kind === 'written'
		? Response.json({ id: written.id, version: written.version }, { status: 201 })
		: Response.json({ message: written.message }, { status: written.status });
});
