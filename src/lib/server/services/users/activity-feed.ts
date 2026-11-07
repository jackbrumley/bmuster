import type { ActivityEntry } from '#lib/domain/activity/activity.ts';
import type { Queryable } from '../../database/connection.ts';
import { listAudit } from '../audit/audit.ts';
import { userNames } from './users.ts';

/** The Activity page: the newest audit entries with the actor's name. */
export function activityFeed(database: Queryable, limit: number): ActivityEntry[] {
	const records = listAudit(database, limit);
	const actorIds = [
		...new Set(
			records.flatMap((record) => (record.actorUserId === null ? [] : [record.actorUserId]))
		)
	];
	const names = userNames(database, actorIds);
	return records.map((record) => {
		const name = record.actorUserId === null ? undefined : names.get(record.actorUserId);
		return {
			id: record.id,
			kind: record.kind,
			atIso: record.at.toISOString(),
			actor: name === undefined ? { kind: 'system' } : { kind: 'user', name },
			target: record.target,
			detail: Object.entries(record.detail).map(([label, value]) => ({ label, value }))
		};
	});
}
