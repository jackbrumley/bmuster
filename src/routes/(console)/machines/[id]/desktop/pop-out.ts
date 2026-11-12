import { DESKTOP_MODES, type DesktopMode } from '#lib/domain/sessions/session.ts';

/**
 * The desktop's pop-out window and the phone layout (SPEC-DESKTOP-POPOUT):
 * the pure parts, so they can be tested without a browser.
 */

/**
 * A phone: a finger on a small screen. The second half catches a phone on
 * its side, whose width can pass the 900px sidebar breakpoint.
 */
export const PHONE_QUERY =
	'(pointer: coarse) and (max-width: 899px), (pointer: coarse) and (max-height: 599px)';

/** A running session handed from the tab to its window. */
export type Handover = { sessionId: string; mode: DesktopMode; sinceMs: number };

type Size = { width: number; height: number };

/** The share of the screen's free area the window may take at most. */
const SCREEN_SHARE = 0.9;

/** One window per machine: a second Pop out finds it by this name. */
export function popOutName(machineId: string): string {
	return `bmuster-desktop-${machineId}`;
}

/** The picture's aspect ratio fitted inside 90% of the screen's free area. */
export function popOutSize(picture: Size, screen: Size): Size {
	const room = { width: screen.width * SCREEN_SHARE, height: screen.height * SCREEN_SHARE };
	const scale = Math.min(room.width / picture.width, room.height / picture.height);
	return {
		width: Math.max(1, Math.floor(picture.width * scale)),
		height: Math.max(1, Math.floor(picture.height * scale))
	};
}

export function popOutFeatures(size: Size): string {
	return `popup,width=${String(size.width)},height=${String(size.height)}`;
}

/** The window's address: its page, with the session it adopts. */
export function popOutUrl(page: string, handover: Handover): string {
	const query = new URLSearchParams({
		sessionId: handover.sessionId,
		mode: handover.mode,
		since: String(handover.sinceMs)
	});
	return `${page}?${query.toString()}`;
}

/** The session a window was opened with, from its address; undefined when there is none or it is malformed. */
export function handoverFrom(search: Pick<URLSearchParams, 'get'>): Handover | undefined {
	const sessionId = search.get('sessionId');
	const mode = DESKTOP_MODES.find((known) => known === search.get('mode'));
	const since = search.get('since');
	const sinceMs = Number(since);
	if (
		sessionId === null ||
		!/^[0-9a-f-]{36}$/i.test(sessionId) ||
		mode === undefined ||
		since === null ||
		!Number.isInteger(sinceMs)
	) {
		return undefined;
	}
	return { sessionId, mode, sinceMs };
}
