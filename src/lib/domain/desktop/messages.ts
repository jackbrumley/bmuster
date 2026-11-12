/**
 * The desktop's JSON control messages (SPEC-DESKTOP 5), as the browser
 * sends them. Browser-safe. The agent reads them in
 * agent/crates/desktop/src/control.rs; replies are parsed with the zod
 * contracts in src/lib/schemas/desktop/.
 */

import { compareAgentVersions } from '../machines/agent-version.ts';

const DESKTOP_QUALITIES = ['auto', 'low', 'medium', 'high', 'extra-high'] as const;
export type DesktopQuality = (typeof DESKTOP_QUALITIES)[number];

/**
 * The levels Auto moves between (SPEC-DESKTOP 20): the fixed qualities of
 * the same name. The agent says which one it picked in `auto-quality`.
 */
export const AUTO_LEVELS = ['low', 'medium', 'high', 'extra-high'] as const;
export type AutoLevel = (typeof AUTO_LEVELS)[number];

/** The first agent that knows `extra-high`; older ones refuse a setting they do not know. */
const EXTRA_HIGH_FROM = '0.4.17';

/** The qualities an agent of `agentVersion` accepts (SPEC-DESKTOP R10, version 2). */
export function desktopQualitiesFor(agentVersion: string): readonly DesktopQuality[] {
	return compareAgentVersions(agentVersion, EXTRA_HIGH_FROM) >= 0
		? DESKTOP_QUALITIES
		: DESKTOP_QUALITIES.filter((quality) => quality !== 'extra-high');
}

/** `fit` scales to the viewer's screen; a number is a fixed factor. */
export const DESKTOP_SCALES = ['fit', 1, 0.75, 0.5, 0.25] as const;
type DesktopScale = (typeof DESKTOP_SCALES)[number];

export const DESKTOP_FRAME_RATES = [5, 10, 15, 30] as const;
type DesktopFrameRate = (typeof DESKTOP_FRAME_RATES)[number];

export type DesktopSettings = {
	quality: DesktopQuality;
	scale: DesktopScale;
	maxFps: DesktopFrameRate;
};

/** The agent's defaults for JPEG tiles (SPEC-DESKTOP 4.3). */
export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
	quality: 'auto',
	scale: 'fit',
	maxFps: 15
};

type SpecialKey = 'ctrl-alt-del' | 'win' | 'alt-tab' | 'print-screen';

/**
 * The display id for every display in one frame (SPEC-DESKTOP-ALL-SCREENS),
 * in `select-display` and in the agent's `displays` and `stream` replies.
 */
export const ALL_DISPLAYS = 'all';

/** Pointer buttons as a bit mask: the same bits as `PointerEvent.buttons`. */
export const BUTTON_LEFT = 1;
export const BUTTON_RIGHT = 2;

/** Browser to agent (SPEC-DESKTOP 5.1). */
export type ViewerMessage =
	| {
			type: 'hello';
			codecs: ('h264' | 'jpeg' | 'webp')[];
			viewport: { width: number; height: number; pixelRatio: number };
	  }
	| { type: 'keyframe' }
	| { type: 'ask-approval' }
	| { type: 'ack'; seq: number }
	| { type: 'select-display'; display: string }
	| ({
			type: 'settings';
			/** Where Auto starts: what the last session on this machine sustained. Older agents ignore it. */
			autoStart: AutoLevel;
	  } & DesktopSettings)
	| { type: 'pointer'; x: number; y: number; buttons: number }
	| { type: 'wheel'; dx: number; dy: number; mode: 'pixel' | 'line' }
	| { type: 'key'; code: string; key: string; down: boolean; altGr: boolean }
	| { type: 'text'; text: string }
	| { type: 'special'; name: SpecialKey }
	| { type: 'release-all' }
	| { type: 'clipboard-push'; text: string }
	| { type: 'clipboard-pull' }
	| { type: 'disconnect' };

/** The most text one clipboard transfer carries, in UTF-8 bytes (SPEC-DESKTOP 21.2). */
export const MAX_CLIPBOARD_BYTES = 1024 * 1024;

/** Input messages a watch-only viewer never sends (SPEC-DESKTOP 7). */
export type InputMessage = Extract<
	ViewerMessage,
	{ type: 'pointer' | 'wheel' | 'key' | 'text' | 'special' | 'release-all' }
>;
