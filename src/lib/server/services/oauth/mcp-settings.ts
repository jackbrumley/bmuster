import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { McpSettingsView } from '#lib/domain/mcp/mcp.ts';
import { settings, userGroupMembers, userGroups, users } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';

/**
 * Settings → AI assistants (SPEC-MCP M1, M2), kept in the settings table under `mcp.*` keys.
 * Off on a new server; it cannot be turned on without naming the group of people who may
 * connect an assistant. Admins are not exempt from the group.
 */

const KEYS = { enabled: 'mcp.enabled', userGroupId: 'mcp.userGroupId' } as const;

const LABELS = {
	enabled: 'Allow AI assistants (MCP)',
	userGroupId: 'People who may connect an AI assistant'
} as const;

export type McpSettings = { enabled: boolean; userGroupId: string | null };

const enabledSchema = z.boolean();
const groupSchema = z.string().nullable();

function stored(database: Queryable, key: string): unknown {
	const row = database.select().from(settings).where(eq(settings.key, key)).get();
	return row === undefined ? undefined : JSON.parse(row.value);
}

export function readMcpSettings(database: Queryable): McpSettings {
	const enabled = stored(database, KEYS.enabled);
	const group = stored(database, KEYS.userGroupId);
	return {
		enabled: enabled === undefined ? false : enabledSchema.parse(enabled),
		userGroupId: group === undefined ? null : groupSchema.parse(group)
	};
}

/** Whether `/mcp`, the OAuth endpoints and the well-known documents answer at all (M1). */
export function mcpEnabled(database: Queryable): boolean {
	return readMcpSettings(database).enabled;
}

export function mcpSettingsView(database: Queryable): McpSettingsView {
	const current = readMcpSettings(database);
	if (current.userGroupId === null) {
		return { enabled: current.enabled, userGroup: { kind: 'none' } };
	}
	const group = database
		.select({ name: userGroups.name })
		.from(userGroups)
		.where(eq(userGroups.id, current.userGroupId))
		.get();
	return {
		enabled: current.enabled,
		userGroup:
			group === undefined
				? { kind: 'missing', id: current.userGroupId }
				: { kind: 'group', id: current.userGroupId, name: group.name }
	};
}

/**
 * Whether this person may hold a grant now (M2, M9): MCP is on, they are not disabled, and they
 * are in the connect group. Checked at consent and again on every token use.
 */
export type Eligibility =
	{ kind: 'eligible' } | { kind: 'ineligible'; why: 'mcp-off' | 'user-disabled' | 'not-in-group' };

export function connectEligibility(database: Queryable, userId: string): Eligibility {
	const current = readMcpSettings(database);
	if (!current.enabled || current.userGroupId === null) {
		return { kind: 'ineligible', why: 'mcp-off' };
	}
	const user = database
		.select({ disabledAt: users.disabledAt })
		.from(users)
		.where(eq(users.id, userId))
		.get();
	if (user?.disabledAt !== null) {
		return { kind: 'ineligible', why: 'user-disabled' };
	}
	const member = database
		.select({ userId: userGroupMembers.userId })
		.from(userGroupMembers)
		.where(
			and(
				eq(userGroupMembers.userGroupId, current.userGroupId),
				eq(userGroupMembers.userId, userId)
			)
		)
		.get();
	return member === undefined ? { kind: 'ineligible', why: 'not-in-group' } : { kind: 'eligible' };
}

export type McpSettingsChange =
	{ kind: 'changed'; settings: McpSettings } | { kind: 'refused'; message: string };

/**
 * Saves both settings for an admin and audits each real change. Turning it on needs a group
 * that exists. The caller ends grants that are no longer allowed (grants.ts).
 */
export function writeMcpSettings(
	database: AppDatabase,
	actorUserId: string,
	next: McpSettings,
	now: number
): McpSettingsChange {
	const current = readMcpSettings(database);
	const groupChanged = next.userGroupId !== current.userGroupId;
	if (
		next.userGroupId !== null &&
		(groupChanged || next.enabled) &&
		database
			.select({ id: userGroups.id })
			.from(userGroups)
			.where(eq(userGroups.id, next.userGroupId))
			.get() === undefined
	) {
		return { kind: 'refused', message: 'That group no longer exists. Choose another.' };
	}
	if (next.enabled && next.userGroupId === null) {
		return {
			kind: 'refused',
			message: 'Choose who may connect an AI assistant before turning this on.'
		};
	}
	database.transaction((transaction) => {
		const before = readMcpSettings(transaction);
		for (const key of ['enabled', 'userGroupId'] as const) {
			if (before[key] === next[key]) {
				continue;
			}
			const value = JSON.stringify(next[key]);
			transaction
				.insert(settings)
				.values({ key: KEYS[key], value, updatedAt: new Date(now), updatedBy: actorUserId })
				.onConflictDoUpdate({
					target: settings.key,
					set: { value, updatedAt: new Date(now), updatedBy: actorUserId }
				})
				.run();
			recordAudit(
				transaction,
				{
					actor: { kind: 'user', userId: actorUserId },
					kind: 'setting-changed',
					target: LABELS[key],
					machineId: null,
					detail: { from: String(before[key]), to: String(next[key]) }
				},
				now
			);
		}
	});
	return { kind: 'changed', settings: readMcpSettings(database) };
}

/** Turns MCP off, audited, without touching the group (the kill switch, M14). */
export function turnMcpOff(database: AppDatabase, actorUserId: string, now: number): void {
	const current = readMcpSettings(database);
	writeMcpSettings(
		database,
		actorUserId,
		{ enabled: false, userGroupId: current.userGroupId },
		now
	);
}
