import type { ActivityEntry } from '#lib/domain/activity/activity.ts';
import type { Queryable } from '../../database/connection.ts';
import {
	listAudit,
	listAuditForMachines,
	type AuditRecord,
	type AuditScope
} from '../audit/audit.ts';
import { userNames } from './users.ts';

const VIA_KEYS: ReadonlySet<string> = new Set(['via', 'viaClientId', 'viaVerified']);

/** The Activity page: the newest audit entries with the actor's name. */
export function activityFeed(
	database: Queryable,
	scope: AuditScope,
	limit: number
): ActivityEntry[] {
	const records =
		scope.kind === 'all'
			? listAudit(database, limit)
			: listAuditForMachines(database, scope.machineIds, limit);
	return withActorNames(database, records);
}

/**
 * Audit records as Activity shows them, with each actor's name (System when there is none). An
 * entry made through an AI assistant names it after the person: "Jack Brumley via Claude Code"
 * (SPEC-MCP M13); its `via…` detail keys are not repeated below.
 */
export function withActorNames(
	database: Queryable,
	records: readonly AuditRecord[]
): ActivityEntry[] {
	const actorIds = [
		...new Set(
			records.flatMap((record) => (record.actorUserId === null ? [] : [record.actorUserId]))
		)
	];
	const names = userNames(database, actorIds);
	return records.map((record) => {
		const name = record.actorUserId === null ? undefined : names.get(record.actorUserId);
		const via = record.detail['via'];
		return {
			id: record.id,
			kind: record.kind,
			atIso: record.at.toISOString(),
			actor:
				name === undefined
					? { kind: 'system' }
					: { kind: 'user', name: via === undefined ? name : `${name} via ${via}` },
			target: record.target,
			detail: Object.entries(record.detail)
				.filter(([label]) => !VIA_KEYS.has(label))
				.map(([label, value]) => ({ label, value }))
		};
	});
}
