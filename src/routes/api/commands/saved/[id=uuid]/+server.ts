import {
	savedCommandDeleteSchema,
	savedCommandWriteSchema
} from '#lib/schemas/commands/saved-commands.ts';
import { route } from '#lib/server/guards/route.ts';
import {
	editSavedCommand,
	removeSavedCommand
} from '#lib/server/services/commands/saved-command-admin.ts';
import { invalidRequest, readJson } from '../../../replies.server.ts';
import { commandContext } from '../../command-context.server.ts';
import type { RequestHandler } from './$types';

/**
 * PUT /api/commands/saved/<id>: edits a saved command, one version on (SPEC-SAVED-COMMANDS SC4,
 * SC5, SC7). Admins only, behind the recent sign-in check, audited with before and after.
 */
export const PUT: RequestHandler = route.admin(async (event, session) => {
	const parsed = savedCommandWriteSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const written = await editSavedCommand(
		commandContext(event, session),
		event.params.id,
		parsed.data
	);
	return written.kind === 'written'
		? Response.json({ id: written.id, version: written.version })
		: Response.json({ message: written.message }, { status: written.status });
});

/** DELETE /api/commands/saved/<id>: the console confirms first (SC4, SC5). */
export const DELETE: RequestHandler = route.admin(async (event, session) => {
	const parsed = savedCommandDeleteSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const removed = await removeSavedCommand(
		commandContext(event, session),
		event.params.id,
		parsed.data.recheck
	);
	return removed.kind === 'deleted'
		? Response.json({ deleted: true })
		: Response.json({ message: removed.message }, { status: removed.status });
});
