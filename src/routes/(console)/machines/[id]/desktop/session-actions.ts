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

/**
 * The session's status: words, or once the picture flows its frame rate and
 * speed apart, so the bars can draw them at a fixed width (SPEC-DESKTOP-FLOATING FB1).
 */
export type SessionStatus =
	{ kind: 'text'; text: string } | { kind: 'figures'; fps: number; kilobytes: number };

function words(text: string): SessionStatus {
	return { kind: 'text', text };
}

export function connectionStatus(
	connection: Connection,
	throughput: Throughput | undefined
): SessionStatus {
	switch (connection.kind) {
		case 'idle':
			return words('Not connected');
		case 'starting':
		case 'connecting':
			return words('Connecting…');
		case 'live': {
			if (!connection.ready) {
				return words('Waiting for the machine…');
			}
			const { fps, bytesPerSecond } = throughput ?? { fps: 0, bytesPerSecond: 0 };
			return { kind: 'figures', fps, kilobytes: Math.round(bytesPerSecond / 1024) };
		}
		case 'reconnecting':
			return words('Reconnecting…');
		case 'moved':
			return words('Open in another window');
		case 'ended':
			return words('Ended');
	}
}

/** Something waiting for the person, shown as a badge on the controls button (SPEC-DESKTOP-FLOATING FB6). */
export type Attention = { kind: 'files' | 'clipboard'; text: string };

/**
 * What needs attention: files copied on the machine first, then a
 * clipboard notice (text from the machine waiting for a tap to land on
 * this device, or the clipboard's last error).
 */
export function attentionOf(
	filesWaiting: string | undefined,
	clipboard: { pending: boolean; error: string | undefined }
): Attention | undefined {
	if (filesWaiting !== undefined) {
		return { kind: 'files', text: filesWaiting };
	}
	if (clipboard.pending) {
		return { kind: 'clipboard', text: 'text copied on the machine, tap to use it here' };
	}
	if (clipboard.error !== undefined) {
		return { kind: 'clipboard', text: `clipboard: ${clipboard.error}` };
	}
	return undefined;
}
