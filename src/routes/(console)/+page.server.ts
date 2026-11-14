import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { page } from '#lib/server/guards/page.ts';
import { AGENT_TARGETS } from '#lib/domain/machines/agent-release.ts';
import { rolloutView } from '#lib/server/services/agents/agent-updates.ts';
import { newestVersion } from '#lib/server/services/agents/update-channels.ts';
import { signedReleases } from '#lib/server/services/agents/releases.ts';
import { visibleMachineIds } from '#lib/server/services/access/access.ts';
import { listMachines } from '#lib/server/services/machines/machine-views.ts';
import type { CommandSelection } from '#lib/domain/commands/commands.ts';
import { commandSelectionFor } from '#lib/server/services/commands/command-selection.ts';
import { donateReminder, type DonateReminder } from '#lib/domain/settings/donate-reminder.ts';
import { readDonateAnswer } from '#lib/server/services/settings/donate-reminder.ts';
import { inUseSince } from '#lib/server/services/users/users.ts';
import type { PageServerLoad } from './$types';

/**
 * Machines: every machine the person may see (SPEC-ACCESS A6). A member who
 * can see none is told their access has not been set up yet (SPEC-SIGN-IN 8.2);
 * an admin with none is offered Add machine. Admins are told when a failed
 * agent update paused the roll-out (SPEC-AGENT-UPDATES). People who may run commands get
 * select mode's tick boxes and group chips (SPEC-COMMANDS C1–C5). Admins may
 * get the donation reminder at the bottom (SPEC-DONATE); admins see every machine.
 */
export const load: PageServerLoad = page.user((_event, { user }) => {
	const now = Date.now();
	const visible = visibleMachineIds(database, user);
	const releases = signedReleases(env.releasesPath, env.agentTestBuildsPath);
	const machines = listMachines(database, now, releases).filter((machine) =>
		visible.has(machine.id)
	);
	if (machines.length === 0 && user.role === 'member') {
		return {
			now,
			rollout: { kind: 'none' as const },
			view: { kind: 'awaiting-access' as const },
			commands: { kind: 'none' as const },
			donate: { kind: 'hidden' as const }
		};
	}
	const rollout =
		user.role === 'admin'
			? rolloutView(database, newestVersion(releases.full, AGENT_TARGETS)?.version, now)
			: { kind: 'none' as const };
	const commands: CommandSelection = commandSelectionFor(database, user, visible);
	const donate: DonateReminder = donateReminder({
		role: user.role,
		inUseSince: inUseSince(database),
		machineCount: machines.length,
		answer: readDonateAnswer(database),
		now
	});
	return { now, rollout, view: { kind: 'machines' as const, machines }, commands, donate };
});
