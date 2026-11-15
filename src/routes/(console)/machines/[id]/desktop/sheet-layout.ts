import { cornerOf, upright, type Area, type FloatingPosition } from './floating-position.ts';
import type { ChromeAction } from './session-actions.ts';

/**
 * The shape of the full-screen controls sheet (SPEC-DESKTOP-FLOATING,
 * option A): a bottom sheet on an upright screen, where width is short and
 * height is not; a full-height side panel on a screen on its side, where
 * height is short. The panel goes on the button's side.
 */
export type SheetLayout = { kind: 'bottom' } | { kind: 'side'; side: 'left' | 'right' };

export function sheetLayout(area: Area, position: FloatingPosition, size: number): SheetLayout {
	if (area.height > area.width) {
		return { kind: 'bottom' };
	}
	if (upright(position.edge)) {
		return { kind: 'side', side: position.edge === 'left' ? 'left' : 'right' };
	}
	const centre = cornerOf(position, area, size).x + size / 2;
	return { kind: 'side', side: centre < area.width / 2 ? 'left' : 'right' };
}

/** Whether a scroll box has more to show above and below, for its fade cues. */
export function scrollEdges(box: {
	scrollTop: number;
	clientHeight: number;
	scrollHeight: number;
}): {
	above: boolean;
	below: boolean;
} {
	// A pixel of slack: browsers round fractional heights.
	return {
		above: box.scrollTop > 1,
		below: box.scrollTop + box.clientHeight < box.scrollHeight - 1
	};
}

export type SheetTab = 'keys' | 'clipboard' | 'picture' | 'screen' | 'session';

/** The sheet's tabs, in order. */
const TABS: readonly { value: SheetTab; label: string }[] = [
	{ value: 'keys', label: 'Keys' },
	{ value: 'clipboard', label: 'Clipboard' },
	{ value: 'picture', label: 'Picture' },
	{ value: 'screen', label: 'Screen' },
	{ value: 'session', label: 'Session' }
];

/**
 * The tab each session action lives in (SPEC-DESKTOP 23): a new action does
 * not compile until it has one.
 */
const HOME: Record<ChromeAction, SheetTab> = {
	mode: 'session',
	keys: 'keys',
	clipboard: 'clipboard',
	upload: 'session',
	download: 'session',
	transfers: 'session',
	settings: 'picture',
	display: 'screen',
	disconnect: 'session'
};

/** Session always (it holds the exit), each other tab while an action of its own is on offer. */
export function sheetTabs(actions: readonly ChromeAction[]): { value: SheetTab; label: string }[] {
	return TABS.filter(
		(tab) => tab.value === 'session' || actions.some((action) => HOME[action] === tab.value)
	);
}
