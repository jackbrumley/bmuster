import type { Connection } from '#lib/runes/session-link.svelte.ts';

/**
 * What the stage shows while it waits, shared by the desktop tab and its
 * pop-out window (SPEC-DESKTOP-POPOUT 11).
 */

/** A session is on its way or running: the stage shows. */
export function isRunning(connection: Connection): boolean {
	return (
		connection.kind === 'live' ||
		connection.kind === 'connecting' ||
		connection.kind === 'starting' ||
		connection.kind === 'reconnecting'
	);
}

/** Until the first picture arrives the stage waits under the veil, saying what it waits for. */
export function connectingTitle(
	connection: Connection,
	pictureShown: boolean,
	machineName: string
): string | undefined {
	if (pictureShown) {
		return undefined;
	}
	switch (connection.kind) {
		case 'starting':
		case 'connecting':
			return `Connecting to ${machineName}`;
		case 'reconnecting':
			return 'Reconnecting';
		case 'live':
			return connection.ready ? 'Waiting for the first picture' : 'Waiting for the machine';
		case 'idle':
		case 'moved':
		case 'ended':
			return undefined;
	}
}
