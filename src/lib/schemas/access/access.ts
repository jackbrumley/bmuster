import { z } from 'zod';
import { CONSENTS, isCompletePermissionSet, PERMISSIONS } from '#lib/domain/access/access.ts';

/** Requests and replies for groups and access rules (SPEC-ACCESS). */

export const groupNameSchema = z
	.string()
	.trim()
	.min(1, 'Give the group a name.')
	.max(80, 'A group name is at most 80 characters.')
	.refine((name) => !/[\r\n]/.test(name), 'A group name is one line.');

export const groupDescriptionSchema = z
	.string()
	.trim()
	.max(500, 'A description is at most 500 characters.');

const groupDetailsSchema = z.object({
	name: groupNameSchema,
	description: groupDescriptionSchema
});

/** POST /api/user-groups and /api/machine-groups. */
export const createGroupRequestSchema = groupDetailsSchema;

/** PATCH /api/user-groups/<id> and /api/machine-groups/<id>: one change at a time. */
export const updateGroupRequestSchema = z.discriminatedUnion('action', [
	groupDetailsSchema.extend({ action: z.literal('set-details') }),
	z.object({ action: z.literal('set-members'), memberIds: z.array(z.uuid()).max(10_000) })
]);

/** PATCH /api/users/<id>/groups: the person's groups, all at once. */
export const setUserGroupsRequestSchema = z.object({
	userGroupIds: z.array(z.uuid()).max(1000)
});

/** PATCH /api/machines/<id>/groups: the machine's groups, all at once. */
export const setMachineGroupsRequestSchema = z.object({
	machineGroupIds: z.array(z.uuid()).max(1000)
});

const permissionsSchema = z
	.array(z.enum(PERMISSIONS))
	.refine(
		(permissions) => new Set(permissions).size === permissions.length,
		'A permission is listed twice.'
	)
	.refine(
		isCompletePermissionSet,
		'Tick at least See inventory. Every permission includes See inventory, and Control desktop includes Watch desktop.'
	);

/** POST /api/access-rules and PATCH /api/access-rules/<id>. */
export const accessRuleRequestSchema = z.object({
	userGroupId: z.uuid(),
	machineGroupId: z.uuid(),
	permissions: permissionsSchema,
	consent: z.enum(CONSENTS)
});

/** The permissions column, read back from the database. */
export const storedPermissionsSchema = z.array(z.enum(PERMISSIONS));

/** Every change answers with what the page needs to refresh itself. */
export const changedReplySchema = z.object({ id: z.uuid() });
