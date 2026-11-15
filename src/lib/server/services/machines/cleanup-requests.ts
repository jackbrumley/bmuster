import { and, asc, desc, eq, isNull, lte } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import type { CleanupItemId, CleanupItemSize } from '#lib/domain/storage/cleanup.ts';
import type { CleanupRequestStatus } from '#lib/domain/storage/cleanup-requests.ts';
import { cleanupItemIdsSchema, cleanupSizesSchema } from '#lib/schemas/storage/cleanup.ts';
import type { Queryable } from '../../database/connection.ts';
import { machines, storageCleanupRequests, storageCleanups, users } from '../../database/schema.ts';

/**
 * Clean-ups an AI assistant asked for (SPEC-MCP M53–M56): the rows, and the one conditional write
 * that decides each, so approve, deny, expiry and a disconnect racing each other settle on one.
 * Only this file touches `storage_cleanup_requests`.
 */

export type CleanupRequestRow = {
	id: string;
	machineId: string;
	machineName: string;
	userId: string;
	userName: string;
	oauthGrantId: string;
	items: CleanupItemId[];
	sizes: CleanupItemSize[];
	reason: string;
	status: CleanupRequestStatus;
	requestedAt: Date;
	expiresAt: Date;
	decidedBy: string | null;
	decidedByName: string | null;
	decidedAt: Date | null;
	denyNote: string | null;
	cleanupId: string | null;
	/** The clean-up's recorded result: JSON `{ kind, items }`, null while it runs. */
	outcome: string | null;
};

const decider = alias(users, 'decider');

function selectRequests(database: Queryable) {
	return database
		.select({
			request: storageCleanupRequests,
			machineName: machines.name,
			userName: users.name,
			decidedByName: decider.name,
			outcome: storageCleanups.outcome
		})
		.from(storageCleanupRequests)
		.innerJoin(machines, eq(machines.id, storageCleanupRequests.machineId))
		.innerJoin(users, eq(users.id, storageCleanupRequests.userId))
		.leftJoin(decider, eq(decider.id, storageCleanupRequests.decidedBy))
		.leftJoin(storageCleanups, eq(storageCleanups.id, storageCleanupRequests.cleanupId));
}

type Selected = Awaited<ReturnType<ReturnType<typeof selectRequests>['all']>>[number];

function toRow(selected: Selected): CleanupRequestRow {
	const { request } = selected;
	return {
		...request,
		machineName: selected.machineName,
		userName: selected.userName,
		decidedByName: selected.decidedByName,
		items: cleanupItemIdsSchema.parse(JSON.parse(request.items)),
		sizes: cleanupSizesSchema.parse(JSON.parse(request.sizes)),
		outcome: selected.outcome
	};
}

export function insertCleanupRequest(
	database: Queryable,
	request: {
		id: string;
		machineId: string;
		userId: string;
		oauthGrantId: string;
		sizes: CleanupItemSize[];
		reason: string;
		requestedAt: number;
		expiresAt: number;
	}
): void {
	database
		.insert(storageCleanupRequests)
		.values({
			id: request.id,
			machineId: request.machineId,
			userId: request.userId,
			oauthGrantId: request.oauthGrantId,
			items: JSON.stringify(request.sizes.map((item) => item.id)),
			sizes: JSON.stringify(request.sizes),
			reason: request.reason,
			status: 'pending',
			requestedAt: new Date(request.requestedAt),
			expiresAt: new Date(request.expiresAt)
		})
		.run();
}

export function findCleanupRequest(
	database: Queryable,
	requestId: string
): CleanupRequestRow | undefined {
	const found = selectRequests(database).where(eq(storageCleanupRequests.id, requestId)).get();
	return found === undefined ? undefined : toRow(found);
}

/** Requests waiting for a decision, newest first. */
export function pendingCleanupRequests(database: Queryable): CleanupRequestRow[] {
	return selectRequests(database)
		.where(eq(storageCleanupRequests.status, 'pending'))
		.orderBy(desc(storageCleanupRequests.requestedAt))
		.all()
		.map(toRow);
}

/** Pending requests whose 10 minutes are up, oldest first. */
export function expiredCleanupRequestIds(database: Queryable, now: number): string[] {
	return database
		.select({ id: storageCleanupRequests.id })
		.from(storageCleanupRequests)
		.where(
			and(
				eq(storageCleanupRequests.status, 'pending'),
				lte(storageCleanupRequests.expiresAt, new Date(now))
			)
		)
		.orderBy(asc(storageCleanupRequests.expiresAt))
		.all()
		.map((row) => row.id);
}

type Settled =
	| { status: 'approved'; decidedBy: string }
	| { status: 'denied'; decidedBy: string; note: string }
	| { status: 'expired' }
	| { status: 'cancelled' };

/**
 * Settles a pending request, only if it is still pending: one conditional write, so whoever
 * comes second changes nothing. True when this call settled it.
 */
export function settleCleanupRequest(
	database: Queryable,
	requestId: string,
	settled: Settled,
	now: number
): boolean {
	const decision =
		settled.status === 'approved'
			? { decidedBy: settled.decidedBy, decidedAt: new Date(now) }
			: settled.status === 'denied'
				? { decidedBy: settled.decidedBy, decidedAt: new Date(now), denyNote: settled.note }
				: {};
	return (
		database
			.update(storageCleanupRequests)
			.set({ status: settled.status, ...decision })
			.where(
				and(eq(storageCleanupRequests.id, requestId), eq(storageCleanupRequests.status, 'pending'))
			)
			.returning({ id: storageCleanupRequests.id })
			.all().length > 0
	);
}

/** The clean-up an approved request started, once the machine accepted it. */
export function linkCleanup(database: Queryable, requestId: string, cleanupId: string): void {
	database
		.update(storageCleanupRequests)
		.set({ cleanupId })
		.where(eq(storageCleanupRequests.id, requestId))
		.run();
}

/**
 * An approval the machine refused (busy, offline): the request waits again, so it can be approved
 * once the machine is ready, until it expires.
 */
export function reopenCleanupRequest(database: Queryable, requestId: string): void {
	database
		.update(storageCleanupRequests)
		.set({ status: 'pending', decidedBy: null, decidedAt: null })
		.where(
			and(
				eq(storageCleanupRequests.id, requestId),
				eq(storageCleanupRequests.status, 'approved'),
				isNull(storageCleanupRequests.cleanupId)
			)
		)
		.run();
}
