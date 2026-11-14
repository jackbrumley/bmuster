import { error } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { SESSION_COOKIE } from '#lib/server/services/auth/sessions.ts';
import { appRunner } from '#lib/server/services/commands/app-runner.ts';
import { approvalViewFor } from '#lib/server/services/commands/approval-views.ts';
import { runViewFor } from '#lib/server/services/commands/run-views.ts';
import type { RunView } from '#lib/domain/commands/commands.ts';
import type { PageServerLoad } from './$types';

/**
 * A run's results (SPEC-COMMANDS C16): only the machines the person can view; a run with none
 * of them is not found. The page then follows the run live. An AI assistant's request still
 * waiting is shown as its approval card to the people who may decide it (SPEC-MCP M28).
 */
/**
 * `?machine=<id>` (a machine's "In use" link, SPEC-COMMANDS C24): open that machine's output,
 * only when it is one of the run's machines this person can view; otherwise just the page.
 */
function openMachineIdOf(url: URL, run: RunView): string | null {
	const wanted = url.searchParams.get('machine');
	return run.machines.some((machine) => machine.machineId === wanted) ? wanted : null;
}

export const load: PageServerLoad = page.user(({ params, cookies, url }, { user }) => {
	const now = Date.now();
	const approval = approvalViewFor(
		{
			database,
			runner: appRunner(),
			user,
			sessionToken: cookies.get(SESSION_COOKIE) ?? '',
			now
		},
		params.id
	);
	const run = runViewFor(database, user, params.id, appRunner());
	if (run === undefined) {
		error(404, 'No command run with this id.');
	}
	return {
		now,
		openMachineId: openMachineIdOf(url, run),
		run,
		approval:
			approval === undefined ? { kind: 'none' as const } : { kind: 'card' as const, view: approval }
	};
});
