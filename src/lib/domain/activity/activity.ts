/** One line of the audit log: who did what to which machine, and when. */

export type ActivityKind =
	| 'terminal-opened'
	| 'desktop-opened'
	| 'file-sent'
	| 'machine-enrolled'
	| 'machine-offline'
	| 'share-link-created';

export type ActivityEntry = {
	id: string;
	kind: ActivityKind;
	atIso: string;
	actor: string;
	machineId: string;
	machineName: string;
	detail: string;
};

export function activityLabel(kind: ActivityKind): string {
	switch (kind) {
		case 'terminal-opened':
			return 'Opened a terminal';
		case 'desktop-opened':
			return 'Opened the desktop';
		case 'file-sent':
			return 'Sent a file';
		case 'machine-enrolled':
			return 'Enrolled the machine';
		case 'machine-offline':
			return 'Went offline';
		case 'share-link-created':
			return 'Created a share link';
	}
}
