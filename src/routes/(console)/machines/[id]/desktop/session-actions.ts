import type { Connection } from '#lib/runes/session-link.svelte.ts';
import type { Throughput } from './desktop-session.svelte.ts';

/**
 * The session's actions, the same in every desktop view (SPEC-DESKTOP 23):
 * the tab's bar, the floating bar of full screen and the pop-out, and the
 * controls button's sheet on touch all show the actions this list says are
 * available now. A new action goes here first; the sheet then needs a tab
 * for it and the parity test a way to find it, or the type check fails.
 */

export const CHROME_ACTIONS = [
	'mode',
	'keys',
	'clipboard',
	'upload',
	'download',
	'transfers',
	'settings',
	'display',
	'disconnect'
] as const;

export type ChromeAction = (typeof CHROME_ACTIONS)[number];

/** The actions that send or fetch files, which a share link never offers. */
export const FILE_ACTIONS: readonly ChromeAction[] = ['upload', 'download', 'transfers'];

/** What decides which actions a view offers now. */
export type ActionState = {
	running: boolean;
	watchOnly: boolean;
	/** The person (or the link) may control the machine, so may change mode. */
	canControl: boolean;
	/** Files may be sent now (SPEC-SESSION-FILES 3.1). */
	canSend: boolean;
	/** Files copied on the machine wait to be downloaded. */
	filesWaiting: boolean;
	/** The Transfers panel is open (it stays closable after sending stops being allowed). */
	transfersOpen: boolean;
	/** How many displays the screen picker offers. */
	displays: number;
};

/** The actions available now, in the order the bars show them. */
export function availableActions(state: ActionState): ChromeAction[] {
	const control = state.running && !state.watchOnly;
	const shown: Record<ChromeAction, boolean> = {
		mode: state.running && state.canControl,
		keys: control,
		clipboard: control,
		upload: state.canSend,
		download: state.filesWaiting,
		transfers: state.canSend || state.transfersOpen,
		settings: state.running,
		display: state.running && state.displays > 1,
		disconnect: state.running
	};
	return CHROME_ACTIONS.filter((action) => shown[action]);
}

/** The session's status in a few words: fps and speed once the picture flows. */
export function connectionStatus(
	connection: Connection,
	throughput: Throughput | undefined
): string {
	switch (connection.kind) {
		case 'idle':
			return 'Not connected';
		case 'starting':
		case 'connecting':
			return 'Connecting…';
		case 'live': {
			if (!connection.ready) {
				return 'Waiting for the machine…';
			}
			const { fps, bytesPerSecond } = throughput ?? { fps: 0, bytesPerSecond: 0 };
			return `${fps} fps · ${Math.round(bytesPerSecond / 1024)} KB/s`;
		}
		case 'reconnecting':
			return 'Reconnecting…';
		case 'moved':
			return 'Open in another window';
		case 'ended':
			return 'Ended';
	}
}
