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
	'machine-removed'
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
	}
}
