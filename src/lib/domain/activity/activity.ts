/** One line of the audit log, as the Activity page shows it. Browser-safe. */

const AUDIT_KINDS = [
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
	'local-code-viewed',
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
	'access-rule-deleted'
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
		case 'local-code-viewed':
			return "Viewed a machine's local page code";
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
	}
}
