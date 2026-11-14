import { error } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import {
	runnableSavedCommand,
	savedRunMachines
} from '#lib/server/services/commands/saved-command-runs.ts';
import type { PageServerLoad } from './$types';

/**
 * Run a saved command (SPEC-SAVED-COMMANDS SC10): the switched-on command and the machines this
 * person may run it on. The server checks all of it again when it runs.
 */
export const load: PageServerLoad = page.user(({ params }, { user }) => {
	const command = runnableSavedCommand(database, params.id);
	if (command === undefined) {
		error(404, 'No saved command with this id.');
	}
	return {
		command: {
			id: command.id,
			name: command.name,
			description: command.description,
			effect: command.effect,
			version: command.version,
			parameters: command.parameters,
			timeoutMs: command.timeoutMs
		},
		machines: savedRunMachines(database, user, command)
	};
});
