/**
 * Share links (SPEC-SHARE-LINKS): someone without an account may reach one
 * machine for a limited time. Browser-safe.
 */

/** How long a link lasts. 24 hours is the most (docs/access-and-sign-in.md 3). */
export const SHARE_DURATIONS = ['15m', '1h', '4h', '8h', '24h'] as const;

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

/** What the guest's session is called at the machine and in Activity. */
export function guestLabel(recipient: string, sharedByName: string): string {
	return `${recipient} (shared by ${sharedByName})`;
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
