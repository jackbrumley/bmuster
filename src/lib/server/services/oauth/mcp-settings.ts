import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { APPROVER_MODES } from '#lib/domain/commands/assistant-runs.ts';
import type { ApproverSettingsView, McpSettingsView } from '#lib/domain/mcp/mcp.ts';
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

/**
 * Who may approve an assistant's request (SPEC-MCP M19): the person it acts as (the default),
 * that person or the approvers group, or only the approvers group. Stored as `mcp.approvers` and
 * `mcp.approverGroupId`.
 */
export type ApproverSettings =
	{ mode: 'requester' } | { mode: 'requester-or-group' | 'group-only'; groupId: string };

const APPROVER_KEYS = { mode: 'mcp.approvers', groupId: 'mcp.approverGroupId' } as const;

const approverModeSchema = z.enum(APPROVER_MODES);

export function readApproverSettings(database: Queryable): ApproverSettings {
	const mode = stored(database, APPROVER_KEYS.mode);
	const group = stored(database, APPROVER_KEYS.groupId);
	const parsedMode = mode === undefined ? 'requester' : approverModeSchema.parse(mode);
	const groupId = group === undefined ? null : groupSchema.parse(group);
	return parsedMode === 'requester' || groupId === null
		? { mode: 'requester' }
		: { mode: parsedMode, groupId };
}

export function approverSettingsView(database: Queryable): ApproverSettingsView {
	const current = readApproverSettings(database);
	if (current.mode === 'requester') {
		return { mode: 'requester', group: { kind: 'none' } };
	}
	const group = database
		.select({ name: userGroups.name })
		.from(userGroups)
		.where(eq(userGroups.id, current.groupId))
		.get();
	return {
		mode: current.mode,
		group:
			group === undefined
				? { kind: 'missing', id: current.groupId }
				: { kind: 'group', id: current.groupId, name: group.name }
	};
}

/** True when this person is in the approvers group the settings name. */
export function inApproverGroup(
	database: Queryable,
	approvers: ApproverSettings,
	userId: string
): boolean {
	if (approvers.mode === 'requester') {
		return false;
	}
	return (
		database
			.select({ userId: userGroupMembers.userId })
			.from(userGroupMembers)
			.where(
				and(
					eq(userGroupMembers.userGroupId, approvers.groupId),
					eq(userGroupMembers.userId, userId)
				)
			)
			.get() !== undefined
	);
}

/** Saves who may approve, for an admin, and audits each real change. The group must exist. */
export function writeApproverSettings(
	database: AppDatabase,
	actorUserId: string,
	next: ApproverSettings,
	now: number
): { kind: 'changed' } | { kind: 'refused'; message: string } {
	if (
		next.mode !== 'requester' &&
		database
			.select({ id: userGroups.id })
			.from(userGroups)
			.where(eq(userGroups.id, next.groupId))
			.get() === undefined
	) {
		return { kind: 'refused', message: 'That group no longer exists. Choose another.' };
	}
	const values = {
		mode: next.mode,
		groupId: next.mode === 'requester' ? null : next.groupId
	};
	const labels = { mode: 'Who may approve AI commands', groupId: 'Approvers group' } as const;
	database.transaction((transaction) => {
		const current = readApproverSettings(transaction);
		const before = {
			mode: current.mode,
			groupId: current.mode === 'requester' ? null : current.groupId
		};
		for (const key of ['mode', 'groupId'] as const) {
			if (before[key] === values[key]) {
				continue;
			}
			const value = JSON.stringify(values[key]);
			transaction
				.insert(settings)
				.values({
					key: APPROVER_KEYS[key],
					value,
					updatedAt: new Date(now),
					updatedBy: actorUserId
				})
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
					target: labels[key],
					machineId: null,
					detail: { from: String(before[key]), to: String(values[key]) }
				},
				now
			);
		}
	});
	return { kind: 'changed' };
}
