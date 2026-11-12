import type { Connection } from '#lib/runes/session-link.svelte.ts';
import type { Size } from './input.ts';
import type { Geometry } from './touch-gestures.ts';

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

/**
 * Where the picture sits on the page, for mapping input: the unzoomed box (the zoom is drawn
 * on the canvases inside it), the stream's size and the shown display's. Undefined until the
 * first frame.
 */
export function stageGeometry(
	picture: HTMLElement | undefined,
	frame: Size | undefined,
	display: Size | undefined
): Geometry | undefined {
	if (picture === undefined || display === undefined || frame === undefined) {
		return undefined;
	}
	const rect = picture.getBoundingClientRect();
	return {
		box: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
		picture: frame,
		display
	};
}

/** The size the agent fits the stream to: the stage's width, and its height in full screen. */
export function stageViewport(
	stage: HTMLElement | undefined,
	fullScreen: boolean
): { width: number; height: number; pixelRatio: number } {
	const rect = stage?.getBoundingClientRect();
	return {
		width: Math.round(rect?.width ?? window.innerWidth),
		height: Math.round(fullScreen ? (rect?.height ?? window.innerHeight) : window.innerHeight),
		pixelRatio: window.devicePixelRatio
	};
}
