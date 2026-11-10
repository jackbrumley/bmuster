import { and, between, desc, eq, gte, inArray } from 'drizzle-orm';
import { isAuditKind, type AuditKind } from '#lib/domain/activity/activity.ts';
import { auditEntries } from '../../database/schema.ts';
import type { Queryable } from '../../database/connection.ts';

/**
 * The audit log (AGENTS.md §11): sign-ins, sign-outs and every change to
 * users, providers and settings. A foundation area: it never imports a
 * feature area, so callers pass the actor's id, not the user.
 */
export type AuditActor = { kind: 'system' } | { kind: 'user'; userId: string };

export type NewAuditEntry = {
	actor: AuditActor;
	kind: AuditKind;
	target: string;
	/** The machine the entry is about, so members see it when they can see the machine (SPEC-ACCESS A6). */
	machineId: string | null;
	detail: Record<string, string>;
};

export type AuditRecord = {
	id: string;
	at: Date;
	actorUserId: string | null;
	kind: AuditKind;
	target: string;
	machineId: string | null;
	detail: Record<string, string>;
};

export function recordAudit(database: Queryable, entry: NewAuditEntry, now: number): void {
	database
		.insert(auditEntries)
		.values({
			id: crypto.randomUUID(),
			at: new Date(now),
			actorUserId: entry.actor.kind === 'user' ? entry.actor.userId : null,
			kind: entry.kind,
			target: entry.target,
			machineId: entry.machineId,
			detail: JSON.stringify(entry.detail)
		})
		.run();
}

/** The newest entries first. */
export function listAudit(database: Queryable, limit: number): AuditRecord[] {
	return database
		.select()
		.from(auditEntries)
		.orderBy(desc(auditEntries.at))
		.limit(limit)
		.all()
		.map(toRecord);
}

/** The newest entries about these machines: what a member sees on Activity (SPEC-ACCESS A6). */
export function listAuditForMachines(
	database: Queryable,
	machineIds: readonly string[],
	limit: number
): AuditRecord[] {
	if (machineIds.length === 0) {
		return [];
	}
	return database
		.select()
		.from(auditEntries)
		.where(inArray(auditEntries.machineId, [...machineIds]))
		.orderBy(desc(auditEntries.at))
		.limit(limit)
		.all()
		.map(toRecord);
}

/**
 * Whose entries: every one, or only those about these machines (what a
 * member may read, SPEC-ACCESS A6).
 */
export type AuditScope = { kind: 'all' } | { kind: 'machines'; machineIds: readonly string[] };

/** The newest entries in the scope between two times (inclusive): the Activity export. */
export function listAuditBetween(
	database: Queryable,
	scope: AuditScope,
	range: { fromMs: number; toMs: number },
	limit: number
): AuditRecord[] {
	const inRange = between(auditEntries.at, new Date(range.fromMs), new Date(range.toMs));
	switch (scope.kind) {
		case 'all':
			return database
				.select()
				.from(auditEntries)
				.where(inRange)
				.orderBy(desc(auditEntries.at))
				.limit(limit)
				.all()
				.map(toRecord);
		case 'machines':
			if (scope.machineIds.length === 0) {
				return [];
			}
			return database
				.select()
				.from(auditEntries)
				.where(and(inRange, inArray(auditEntries.machineId, [...scope.machineIds])))
				.orderBy(desc(auditEntries.at))
				.limit(limit)
				.all()
				.map(toRecord);
	}
}

/** One machine's newest entries of these kinds since a time: its sessions (SPEC-DIAGNOSTICS 3). */
export function listMachineAudit(
	database: Queryable,
	query: { machineId: string; kinds: readonly AuditKind[]; sinceMs: number; limit: number }
): AuditRecord[] {
	return database
		.select()
		.from(auditEntries)
		.where(
			and(
				eq(auditEntries.machineId, query.machineId),
				inArray(auditEntries.kind, [...query.kinds]),
				gte(auditEntries.at, new Date(query.sinceMs))
			)
		)
		.orderBy(desc(auditEntries.at))
		.limit(query.limit)
		.all()
		.map(toRecord);
}

/** Every machine's entries of these kinds since a time, oldest first: sessions left open (SPEC-SESSIONS T9). */
export function listAuditOfKinds(
	database: Queryable,
	query: { kinds: readonly AuditKind[]; sinceMs: number; limit: number }
): AuditRecord[] {
	return database
		.select()
		.from(auditEntries)
		.where(
			and(
				inArray(auditEntries.kind, [...query.kinds]),
				gte(auditEntries.at, new Date(query.sinceMs))
			)
		)
		.orderBy(auditEntries.at)
		.limit(query.limit)
		.all()
		.map(toRecord);
}

function toRecord(row: typeof auditEntries.$inferSelect): AuditRecord {
	if (!isAuditKind(row.kind)) {
		throw new Error(`audit_entries ${row.id} has an unknown kind '${row.kind}'`);
	}
	return {
		id: row.id,
		at: row.at,
		actorUserId: row.actorUserId,
		kind: row.kind,
		target: row.target,
		machineId: row.machineId,
		detail: parseDetail(row.id, row.detail)
	};
}

function parseDetail(id: string, json: string): Record<string, string> {
	const value: unknown = JSON.parse(json);
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error(`audit_entries ${id} has a detail that is not an object`);
	}
	const detail: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== 'string') {
			throw new Error(`audit_entries ${id} has a non-text detail '${key}'`);
		}
		detail[key] = item;
	}
	return detail;
}
