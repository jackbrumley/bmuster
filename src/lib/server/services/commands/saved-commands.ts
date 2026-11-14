import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { COMMAND_OS_FAMILIES } from '#lib/domain/commands/commands.ts';
import type { SavedCommandView } from '#lib/domain/commands/saved-commands.ts';
import type { SavedCommandFields } from '#lib/schemas/commands/saved-commands.ts';
import { savedParameterSchema, savedScriptSchema } from '#lib/schemas/commands/saved-commands.ts';
import type { Queryable } from '../../database/connection.ts';
import { savedCommands } from '../../database/schema.ts';

/**
 * Saved commands in the database (SPEC-SAVED-COMMANDS 6): the only code that touches the
 * saved_commands table. Scripts, parameters and groups are JSON, read back through the schemas
 * that let them in, so a bad row fails loudly instead of running as something else.
 */

type Row = typeof savedCommands.$inferSelect;

const groupIdsSchema = z.array(z.string());

function toView(row: Row): SavedCommandView {
	const scripts = z.array(savedScriptSchema).parse(JSON.parse(row.scripts));
	return {
		id: row.id,
		name: row.name,
		description: row.description,
		effect: row.effect,
		systems: COMMAND_OS_FAMILIES.filter((family) =>
			scripts.some((script) => script.osFamily === family)
		),
		enabled: row.enabled,
		aiUnattended: row.aiUnattended,
		version: row.version,
		scripts,
		parameters: z.array(savedParameterSchema).parse(JSON.parse(row.parameters)),
		machineGroupIds: groupIdsSchema.parse(JSON.parse(row.machineGroupIds)),
		timeoutMs: row.timeoutMs
	};
}

/** Every saved command, by name. */
export function allSavedCommands(database: Queryable): SavedCommandView[] {
	return database.select().from(savedCommands).orderBy(asc(savedCommands.name)).all().map(toView);
}

export function findSavedCommand(database: Queryable, id: string): SavedCommandView | undefined {
	const row = database.select().from(savedCommands).where(eq(savedCommands.id, id)).get();
	return row === undefined ? undefined : toView(row);
}

/** True when another saved command has this name, ignoring case. */
export function nameTaken(database: Queryable, name: string, exceptId: string | null): boolean {
	const wanted = name.trim().toLowerCase();
	return allSavedCommands(database).some(
		(command) => command.id !== exceptId && command.name.toLowerCase() === wanted
	);
}

function columns(fields: SavedCommandFields) {
	return {
		name: fields.name,
		description: fields.description,
		scripts: JSON.stringify(fields.scripts),
		parameters: JSON.stringify(fields.parameters),
		machineGroupIds: JSON.stringify(fields.machineGroupIds),
		effect: fields.effect,
		enabled: fields.enabled,
		aiUnattended: fields.aiUnattended,
		timeoutMs: fields.timeoutMs
	};
}

export function insertSavedCommand(
	database: Queryable,
	command: { id: string; fields: SavedCommandFields; userId: string; now: number }
): void {
	database
		.insert(savedCommands)
		.values({
			id: command.id,
			...columns(command.fields),
			version: 1,
			createdAt: new Date(command.now),
			updatedAt: new Date(command.now),
			updatedBy: command.userId
		})
		.run();
}

/** Saves an edit, one version on (SC7). */
export function updateSavedCommand(
	database: Queryable,
	command: { id: string; fields: SavedCommandFields; version: number; userId: string; now: number }
): void {
	database
		.update(savedCommands)
		.set({
			...columns(command.fields),
			version: command.version,
			updatedAt: new Date(command.now),
			updatedBy: command.userId
		})
		.where(eq(savedCommands.id, command.id))
		.run();
}

export function deleteSavedCommand(database: Queryable, id: string): void {
	database.delete(savedCommands).where(eq(savedCommands.id, id)).run();
}
