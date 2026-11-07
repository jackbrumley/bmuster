import { apiRequest, type ApiResult } from '#lib/utils/api-client.ts';
import { changedReplySchema } from '#lib/schemas/access/access.ts';
import { userReplySchema } from '#lib/schemas/users/users.ts';
import type { ConsoleRole, UserView } from '#lib/domain/users/user.ts';

/** The Users page's requests. Each returns the user as the server now has them. */
type UserUpdate =
	| { action: 'set-details'; name: string; email: string }
	| { action: 'set-role'; role: ConsoleRole }
	| { action: 'disable' }
	| { action: 'enable' }
	| { action: 'set-password'; password: string };

export async function updateUser(id: string, update: UserUpdate): Promise<ApiResult<UserView>> {
	const result = await apiRequest({
		method: 'PATCH',
		url: `/api/users/${id}`,
		body: update,
		reply: userReplySchema
	});
	return result.ok ? { ok: true, data: result.data.user } : result;
}

export async function addUser(input: {
	name: string;
	email: string;
	role: ConsoleRole;
	password: { kind: 'none' } | { kind: 'set'; value: string };
}): Promise<ApiResult<UserView>> {
	const result = await apiRequest({
		method: 'POST',
		url: '/api/users',
		body: input,
		reply: userReplySchema
	});
	return result.ok ? { ok: true, data: result.data.user } : result;
}

/** Puts the person in exactly these user groups (SPEC-ACCESS A1). */
export async function setUserGroups(id: string, userGroupIds: string[]): Promise<ApiResult<null>> {
	const result = await apiRequest({
		method: 'PATCH',
		url: `/api/users/${id}/groups`,
		body: { userGroupIds },
		reply: changedReplySchema
	});
	return result.ok ? { ok: true, data: null } : result;
}
