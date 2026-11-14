import type { SavedCommandFields } from '#lib/schemas/commands/saved-commands.ts';
import type { AppDatabase } from '#lib/server/database/connection.ts';
import { insertSavedCommand } from '#lib/server/services/commands/saved-commands.ts';
import { NOW } from './people.ts';

/**
 * Saved commands for the SPEC-SAVED-COMMANDS tests: a valid command to start from, and one
 * written straight into the database.
 */

/** The built-in All machines group (migration 0006). */
export const ALL_MACHINES = '00000000-0000-4000-8000-00000000a11a';

export const LINUX_SCRIPT = 'df -h "$BMUSTER_PARAM_MOUNT"';
export const WINDOWS_SCRIPT = 'Get-PSDrive -Name $env:BMUSTER_PARAM_MOUNT';

/** "Free space" on All machines, Linux only, one text parameter, switched on, AI on. */
export function savedFields(overrides: Partial<SavedCommandFields> = {}): SavedCommandFields {
	return {
		name: 'Free space',
		description: 'Free space on one mount.',
		scripts: [{ osFamily: 'linux', shell: 'sh', script: LINUX_SCRIPT }],
		machineGroupIds: [ALL_MACHINES],
		parameters: [{ kind: 'text', name: 'mount', label: 'Mount', pattern: 'path' }],
		effect: 'reads-only',
		enabled: true,
		aiUnattended: true,
		timeoutMs: 30_000,
		...overrides
	};
}

/** A saved command at version 1, as if an admin had saved it. */
export function addSaved(
	database: AppDatabase,
	adminId: string,
	fields: SavedCommandFields = savedFields()
): string {
	const id = crypto.randomUUID();
	insertSavedCommand(database, { id, fields, userId: adminId, now: NOW });
	return id;
}
