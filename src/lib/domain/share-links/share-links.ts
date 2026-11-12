/**
 * Share links (SPEC-SHARE-LINKS): someone without an account may reach one
 * machine for a limited time. Browser-safe.
 */

/** How long a link lasts. 7 days is the most (docs/access-and-sign-in.md 3, SPEC-SHARE-LINKS D16). */
export const SHARE_DURATIONS = ['15m', '1h', '4h', '8h', '24h', '48h', '7d'] as const;

export type ShareDuration = (typeof SHARE_DURATIONS)[number];

const MINUTE_MS = 60_000;

export function shareDurationMs(duration: ShareDuration): number {
	switch (duration) {
		case '15m':
			return 15 * MINUTE_MS;
		case '1h':
			return 60 * MINUTE_MS;
		case '4h':
			return 4 * 60 * MINUTE_MS;
		case '8h':
			return 8 * 60 * MINUTE_MS;
		case '24h':
			return 24 * 60 * MINUTE_MS;
		case '48h':
			return 48 * 60 * MINUTE_MS;
		case '7d':
			return 7 * 24 * 60 * MINUTE_MS;
	}
}

export function shareDurationLabel(duration: ShareDuration): string {
	switch (duration) {
		case '15m':
			return '15 minutes';
		case '1h':
			return '1 hour';
		case '4h':
			return '4 hours';
		case '8h':
			return '8 hours';
		case '24h':
			return '24 hours';
		case '48h':
			return '48 hours';
		case '7d':
			return '7 days';
	}
}

/**
 * What a link may carry: watching is always on; control and files are ticked.
 * Terminal is never offered: anyone who needs a shell gets an account.
 */
export const SHARE_LINK_PERMISSIONS = ['desktop-view', 'desktop-control', 'files'] as const;

export type ShareLinkPermission = (typeof SHARE_LINK_PERMISSIONS)[number];

/** The link's permissions from the two tick boxes, in list order. */
export function sharePermissionsFrom(ticks: {
	control: boolean;
	files: boolean;
}): ShareLinkPermission[] {
	return SHARE_LINK_PERMISSIONS.filter(
		(permission) =>
			permission === 'desktop-view' ||
			(permission === 'desktop-control' && ticks.control) ||
			(permission === 'files' && ticks.files)
	);
}

/** "Control desktop, Files", or "Watch desktop" for a watch-only link. */
export function sharePermissionsLabel(permissions: readonly ShareLinkPermission[]): string {
	const desktop = permissions.includes('desktop-control') ? 'Control desktop' : 'Watch desktop';
	return [desktop, ...(permissions.includes('files') ? ['Files'] : [])].join(', ');
}

/** The most links one machine may have active at once (SPEC-SHARE-LINKS D12). */
export const MAX_ACTIVE_LINKS_PER_MACHINE = 20;

/** Longest recipient label. */
export const RECIPIENT_MAX_LENGTH = 80;

/** Longest name and company a guest may give (SPEC-SHARE-LINKS D17). */
export const GUEST_NAME_MAX_LENGTH = 80;
export const GUEST_COMPANY_MAX_LENGTH = 80;

/**
 * Who the guest says they are, typed on the guest page before connecting (D17). Self-declared:
 * nothing checks it, so admins see it as "says they are". `company` is '' when not given.
 */
export type GuestIdentity = { name: string; company: string };

/** "Alex Smith (Acme)", or "Alex Smith" with no company. */
export function declaredLabel(identity: GuestIdentity): string {
	return identity.company === '' ? identity.name : `${identity.name} (${identity.company})`;
}

/** The last guest session through a link: who they said they were, from where, when (D17). */
export type ShareLinkLastUse =
	| { kind: 'never' }
	| { kind: 'used'; name: string; company: string; address: string; atIso: string };

/**
 * "Last used by someone who says they are Alex Smith (Acme), from 203.0.113.5, 5 min ago", or
 * "Not used yet". `when` is the time already worded for the reader.
 */
export function lastUseLabel(lastUse: ShareLinkLastUse, when: (iso: string) => string): string {
	switch (lastUse.kind) {
		case 'never':
			return 'Not used yet';
		case 'used':
			return `Last used by someone who says they are ${declaredLabel(lastUse)}, from ${lastUse.address}, ${when(lastUse.atIso)}`;
	}
}

/** "15 min" to "7 days": the short words for the duration picker. */
export function shareDurationShortLabel(duration: ShareDuration): string {
	switch (duration) {
		case '15m':
			return '15 min';
		case '1h':
			return '1 h';
		case '4h':
			return '4 h';
		case '8h':
			return '8 h';
		case '24h':
			return '24 h';
		case '48h':
			return '48 h';
		case '7d':
			return '7 days';
	}
}

/** One active link, as a machine's page and the admins' list show it. */
export type ShareLinkView = {
	id: string;
	machineId: string;
	machineName: string;
	recipient: string;
	permissions: ShareLinkPermission[];
	createdByName: string;
	createdIso: string;
	expiresIso: string;
	lastUse: ShareLinkLastUse;
};

/** What the guest page knows: one machine, who shared it, until when (SPEC-SHARE-LINKS D10). */
export type GuestView = {
	machineName: string;
	osFamily: 'windows' | 'linux' | 'macos';
	recipient: string;
	sharedByName: string;
	permissions: ShareLinkPermission[];
	expiresIso: string;
};

/** The link before anyone has said who they are (the page was opened): "<recipient> (shared by <name>)". */
export function linkLabel(recipient: string, sharedByName: string): string {
	return `${recipient} (shared by ${sharedByName})`;
}

/** What a guest's session is called at the machine: "Alex Smith (Acme) via a link from Jack Brumley". */
export function guestLabel(identity: GuestIdentity, sharedByName: string): string {
	return `${declaredLabel(identity)} via a link from ${sharedByName}`;
}

/** "1 h 5 min", "4 min 10 s", "Ended": time left until `expiresMs`. */
export function timeLeftLabel(expiresMs: number, nowMs: number): string {
	const seconds = Math.floor((expiresMs - nowMs) / 1000);
	if (seconds <= 0) {
		return 'Ended';
	}
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	if (hours > 0) {
		return `${hours} h ${minutes} min`;
	}
	return minutes > 0 ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}
