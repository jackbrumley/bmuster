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
export { commandRunMachines, commandRunScripts, commandRuns } from './schema/commands.ts';
export { diagnosticsTokens } from './schema/diagnostics-tokens.ts';
export { emailMessages } from './schema/email.ts';
export { identityProviders } from './schema/identity-providers.ts';
export { joinCodes } from './schema/join-codes.ts';
export { localCertificates } from './schema/local-certificates.ts';
export { agentLogRecords, serverLogRecords } from './schema/logs.ts';
export {
	machineChecks,
	machineInventory,
	machineLocalPages,
	machineNotes,
	machineStatus,
	machineStorage,
	machines,
	storageCleanups
} from './schema/machines.ts';
export { notificationEvents, notificationRules } from './schema/notifications.ts';
export { oauthClients, oauthCodes, oauthGrants, oauthTokens } from './schema/oauth.ts';
export { passwordLinks } from './schema/password-links.ts';
export { serverKeys } from './schema/server-keys.ts';
export { consoleSessions, signInFailures } from './schema/sessions.ts';
export { shareLinkFailures, shareLinks } from './schema/share-links.ts';
export { settings } from './schema/settings.ts';
export { supportCodeFailures, supportCodes } from './schema/support-codes.ts';
export { recoveryCodes, signInChallenges, totpAuthenticators } from './schema/two-factor.ts';
export { userIdentities, users } from './schema/users.ts';
