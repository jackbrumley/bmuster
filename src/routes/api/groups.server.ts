import { createGroupRequestSchema, updateGroupRequestSchema } from '#lib/schemas/access/access.ts';
import { database } from '#lib/server/database/app-database.ts';
import type { SessionContext } from '#lib/server/guards/checks.ts';
import {
	createGroup,
	deleteGroup,
	setGroupMembers,
	updateGroupDetails,
	type GroupChange,
	type GroupKind
} from '#lib/server/services/access/groups.ts';
import type { RuleChange } from '#lib/server/services/access/rules.ts';
import { invalidRequest, readJson } from './replies.server.ts';

/**
 * The handlers behind /api/user-groups and /api/machine-groups (SPEC-ACCESS
 * A1, A2), written once for both kinds. The routes guard them (admins).
 */
export function changeReply(result: GroupChange | RuleChange, created: boolean): Response {
	return result.kind === 'done'
		? Response.json({ id: result.id }, { status: created ? 201 : 200 })
		: Response.json({ message: result.message }, { status: result.status });
}

export async function createGroupHandler(
	kind: GroupKind,
	request: Request,
	{ user }: SessionContext
): Promise<Response> {
	const parsed = createGroupRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	return changeReply(createGroup(database, kind, user.id, parsed.data, Date.now()), true);
}

export async function updateGroupHandler(
	kind: GroupKind,
	request: Request,
	id: string,
	{ user }: SessionContext
): Promise<Response> {
	const parsed = updateGroupRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const now = Date.now();
	switch (parsed.data.action) {
		case 'set-details':
			return changeReply(
				updateGroupDetails(
					database,
					kind,
					user.id,
					id,
					{ name: parsed.data.name, description: parsed.data.description },
					now
				),
				false
			);
		case 'set-members':
			return changeReply(
				setGroupMembers(database, kind, user.id, id, parsed.data.memberIds, now),
				false
			);
	}
}

export function deleteGroupHandler(
	kind: GroupKind,
	id: string,
	{ user }: SessionContext
): Response {
	return changeReply(deleteGroup(database, kind, user.id, id, Date.now()), false);
}
