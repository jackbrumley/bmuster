/** One line of the audit log, as the Activity page shows it. Browser-safe. */

const AUDIT_KINDS = [
	'server-update-checked',
	'server-update-requested',
	'setup',
	'sign-in',
	'sign-in-failed',
	'sign-out',
	'user-added',
	'user-details-changed',
	'user-role-changed',
	'user-disabled',
	'user-enabled',
	'user-password-set',
	'provider-added',
	'provider-changed',
	'provider-deleted',
	'setting-changed',
	'local-certificate-renewed',
	'machine-enrolled',
	'machine-removed',
	'machine-renamed',
	'machine-description-changed',
	'machine-note-deleted',
	'machine-reinstalled',
	'machine-moved',
	'machine-uninstalled',
	// SPEC-LOCAL-PAGE-TRANSPARENCY
	'machine-removed-at-machine',
	'local-code-viewed',
	'local-signed-in',
	'local-signed-out',
	'local-session-expired',
	'local-wrong-code',
	'local-locked-out',
	'local-restarted',
	'local-connection-tested',
	'local-move-started',
	'local-move-finished',
	'local-move-failed',
	'local-leaving',
	'local-uninstalled',
	'local-events-dropped',
	'user-group-added',
	'user-group-changed',
	'user-group-deleted',
	'user-group-member-added',
	'user-group-member-removed',
	'machine-group-added',
	'machine-group-changed',
	'machine-group-deleted',
	'machine-group-member-added',
	'machine-group-member-removed',
	'access-rule-added',
	'access-rule-changed',
	'access-rule-deleted',
	'session-opened',
	'session-ended',
	// SPEC-DESKTOP
	'session-disconnected-at-machine',
	'machine-message-sent',
	// SPEC-EMAIL
	'email-sent',
	'email-failed',
	'password-reset-requested',
	'password-reset',
	'invitation-created',
	'invitation-accepted',
	'notification-rule-added',
	'notification-rule-changed',
	'notification-rule-deleted',
	// SPEC-AGENT-UPDATES
	'agent-updated',
	'agent-update-rolled-back',
	'agent-update-refused',
	'agent-update-requested',
	'agent-pinned',
	'agent-unpinned',
	'agent-rollout-paused',
	'agent-rollout-resumed',
	// SPEC-AGENT-LOGS
	'agent-logs-viewed',
	'server-logs-viewed',
	'agent-verbose-started',
	'agent-verbose-stopped',
	'diagnostics-token-created',
	'diagnostics-token-revoked',
	'diagnostics-token-used',
	// SPEC-DIAGNOSTICS
	'agent-checks-requested',
	'agent-sessions-viewed',
	// SPEC-CSV-EXPORT
	'list-exported',
	// SPEC-FILES
	'file-downloaded',
	'file-uploaded',
	'files-deleted',
	'file-renamed',
	'folder-created',
	'storage-rescan-requested',
	'storage-cleanup-started',
	'storage-cleanup',
	// SPEC-PRESENCE
	'machine-offline',
	'machine-online',
	// SPEC-JOIN
	'support-code-started',
	'support-code-cancelled',
	'support-code-entered',
	'support-code-scam-stop',
	// SPEC-STAY-AWAKE
	'machine-power-policy-changed'
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

export function isAuditKind(kind: string): kind is AuditKind {
	return AUDIT_KINDS.some((known) => known === kind);
}

export type ActivityEntry = {
	id: string;
	kind: AuditKind;
	atIso: string;
	actor: { kind: 'system' } | { kind: 'user'; name: string };
	target: string;
	/** "key: value" pairs from the entry's detail, already in display order. */
	detail: { label: string; value: string }[];
};

export function activityLabel(kind: AuditKind): string {
	switch (kind) {
		case 'setup':
			return 'Set up this server';
		case 'sign-in':
			return 'Signed in';
		case 'sign-in-failed':
			return 'Sign-in refused';
		case 'sign-out':
			return 'Signed out';
		case 'user-added':
			return 'Added a user';
		case 'user-details-changed':
			return 'Changed a name or email';
		case 'user-role-changed':
			return 'Changed a role';
		case 'user-disabled':
			return 'Disabled a user';
		case 'user-enabled':
			return 'Enabled a user';
		case 'user-password-set':
			return 'Set a password';
		case 'provider-added':
			return 'Added a sign-in provider';
		case 'provider-changed':
			return 'Changed a sign-in provider';
		case 'provider-deleted':
			return 'Deleted a sign-in provider';
		case 'server-update-checked':
			return 'Checked for server updates';
		case 'server-update-requested':
			return 'Requested a server update';
		case 'setting-changed':
			return 'Changed a setting';
		case 'local-certificate-renewed':
			return 'Made a new local network certificate';
		case 'machine-enrolled':
			return 'Enrolled a machine';
		case 'machine-removed':
			return 'Removed a machine';
		case 'machine-renamed':
			return 'Renamed a machine';
		case 'machine-description-changed':
			return "Changed a machine's description";
		case 'machine-note-deleted':
			return 'Deleted a note on a machine';
		case 'machine-reinstalled':
			return "Reinstalled a machine's agent";
		case 'machine-moved':
			return 'Recorded that a machine moved to another server';
		case 'machine-uninstalled':
			return "Recorded that a machine's agent was uninstalled";
		case 'machine-removed-at-machine':
			return 'BMuster was removed at a machine by a local administrator';
		case 'local-code-viewed':
			return "Viewed a machine's local page code";
		case 'local-signed-in':
			return 'Signed in to a local page';
		case 'local-signed-out':
			return 'Signed out of a local page';
		case 'local-session-expired':
			return 'A local page session ended';
		case 'local-wrong-code':
			return 'A wrong local page code';
		case 'local-locked-out':
			return 'Local page sign-in paused';
		case 'local-restarted':
			return 'Restarted an agent from its local page';
		case 'local-connection-tested':
			return 'Tested the connection from a local page';
		case 'local-move-started':
			return 'Started a move from a local page';
		case 'local-move-finished':
			return 'Moved a machine from its local page';
		case 'local-move-failed':
			return 'A move from a local page failed';
		case 'local-leaving':
			return 'An agent told this server it is leaving';
		case 'local-uninstalled':
			return 'Uninstalled an agent from its local page';
		case 'local-events-dropped':
			return 'Local page events were lost';
		case 'user-group-added':
			return 'Added a group of people';
		case 'user-group-changed':
			return 'Changed a group of people';
		case 'user-group-deleted':
			return 'Deleted a group of people';
		case 'user-group-member-added':
			return 'Added someone to a group';
		case 'user-group-member-removed':
			return 'Took someone out of a group';
		case 'machine-group-added':
			return 'Added a group of machines';
		case 'machine-group-changed':
			return 'Changed a group of machines';
		case 'machine-group-deleted':
			return 'Deleted a group of machines';
		case 'machine-group-member-added':
			return 'Added a machine to a group';
		case 'machine-group-member-removed':
			return 'Took a machine out of a group';
		case 'access-rule-added':
			return 'Added an access rule';
		case 'access-rule-changed':
			return 'Changed an access rule';
		case 'access-rule-deleted':
			return 'Deleted an access rule';
		case 'session-opened':
			return 'Opened a session';
		case 'session-ended':
			return 'Closed a session';
		case 'session-disconnected-at-machine':
			return 'Disconnected at the machine';
		case 'machine-message-sent':
			return 'Sent a message to the screen';
		case 'email-sent':
			return 'Sent an email';
		case 'email-failed':
			return 'Could not send an email';
		case 'password-reset-requested':
			return 'Asked for a password reset';
		case 'password-reset':
			return 'Reset a password by email';
		case 'invitation-created':
			return 'Invited someone to set a password';
		case 'invitation-accepted':
			return 'Accepted an invitation';
		case 'notification-rule-added':
			return 'Added a notification rule';
		case 'notification-rule-changed':
			return 'Changed a notification rule';
		case 'notification-rule-deleted':
			return 'Deleted a notification rule';
		case 'agent-updated':
			return "Updated a machine's agent";
		case 'agent-update-rolled-back':
			return 'Rolled back an agent update';
		case 'agent-update-refused':
			return 'Refused an agent update';
		case 'agent-update-requested':
			return 'Asked an agent to update now';
		case 'agent-pinned':
			return "Pinned a machine's agent version";
		case 'agent-unpinned':
			return "Unpinned a machine's agent version";
		case 'agent-rollout-paused':
			return 'Paused the agent roll-out';
		case 'agent-rollout-resumed':
			return 'Resumed the agent roll-out';
		case 'agent-logs-viewed':
			return 'Read agent logs';
		case 'server-logs-viewed':
			return 'Read the server log';
		case 'agent-verbose-started':
			return 'Made an agent log verbosely';
		case 'agent-verbose-stopped':
			return 'Set an agent back to normal logging';
		case 'diagnostics-token-created':
			return 'Created a diagnostics token';
		case 'diagnostics-token-revoked':
			return 'Revoked a diagnostics token';
		case 'diagnostics-token-used':
			return 'Used a diagnostics token';
		case 'agent-checks-requested':
			return "Ran an agent's self-checks";
		case 'agent-sessions-viewed':
			return "Read a machine's session timelines";
		case 'list-exported':
			return 'Exported a list';
		case 'file-downloaded':
			return 'Downloaded a file';
		case 'file-uploaded':
			return 'Uploaded a file';
		case 'files-deleted':
			return 'Deleted files';
		case 'file-renamed':
			return 'Renamed a file';
		case 'folder-created':
			return 'Made a folder';
		case 'storage-rescan-requested':
			return 'Asked for a storage scan';
		case 'storage-cleanup-started':
			return 'Started a disk clean-up';
		case 'storage-cleanup':
			return 'Cleaned up disk space';
		case 'machine-offline':
			return 'A machine went offline';
		case 'machine-online':
			return 'A machine came back online';
		case 'support-code-started':
			return 'Created an enrolment code';
		case 'support-code-cancelled':
			return 'Cancelled an enrolment code';
		case 'support-code-entered':
			return 'An enrolment code was entered on /join';
		case 'support-code-scam-stop':
			return 'An enrolment code was stopped by the scam check';
		case 'machine-power-policy-changed':
			return 'Changed Stay awake on mains power';
	}
}
