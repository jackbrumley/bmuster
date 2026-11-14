import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import {
	canWriteSavedCommands,
	savedCommandsFor
} from '#lib/server/services/commands/saved-command-runs.ts';
import type { PageServerLoad } from './$types';

/**
 * Commands → Saved commands (SPEC-SAVED-COMMANDS SC1): every saved command for an admin, who
 * writes them; for anyone else the switched-on ones they may run somewhere.
 */
export const load: PageServerLoad = page.user((_event, { user }) => ({
	commands: savedCommandsFor(database, user),
	canWrite: canWriteSavedCommands(user)
}));
