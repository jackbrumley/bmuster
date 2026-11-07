/** Every table, for Drizzle and drizzle-kit. Each area's tables live in schema/<area>.ts. */
export {
	accessRules,
	machineGroupMembers,
	machineGroups,
	userGroupMembers,
	userGroups
} from './schema/access.ts';
export { agentRollouts, machineUpdates } from './schema/agent-updates.ts';
export { auditEntries } from './schema/audit.ts';
export { emailMessages } from './schema/email.ts';
export { identityProviders } from './schema/identity-providers.ts';
export { joinCodes } from './schema/join-codes.ts';
export { localCertificates } from './schema/local-certificates.ts';
export {
	machineInventory,
	machineLocalPages,
	machineNotes,
	machineStatus,
	machines
} from './schema/machines.ts';
export { notificationEvents, notificationRules } from './schema/notifications.ts';
export { passwordLinks } from './schema/password-links.ts';
export { serverKeys } from './schema/server-keys.ts';
export { consoleSessions, signInFailures } from './schema/sessions.ts';
export { settings } from './schema/settings.ts';
export { userIdentities, users } from './schema/users.ts';
