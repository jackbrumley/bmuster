import { apiRequest, type ApiResult } from '#lib/utils/api-client.ts';
import { changedReplySchema } from '#lib/schemas/access/access.ts';
import {
	createUserReplySchema,
	invitationReplySchema,
	userReplySchema
} from '#lib/schemas/users/users.ts';
import type { Invitation, SignInChoice } from '#lib/domain/users/invitation.ts';
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
	signIn: SignInChoice;
}): Promise<ApiResult<{ user: UserView; invitation: Invitation }>> {
	return apiRequest({
		method: 'POST',
		url: '/api/users',
		body: input,
		reply: createUserReplySchema
	});
}

/** A fresh invitation for someone with no password yet (SPEC-EMAIL E5). */
export async function sendInvitation(id: string): Promise<ApiResult<Invitation>> {
	const result = await apiRequest({
		method: 'POST',
		url: `/api/users/${id}/invitation`,
		body: {},
		reply: invitationReplySchema
	});
	return result.ok ? { ok: true, data: result.data.invitation } : result;
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
