/**
 * Whether this browser has dismissed the touch gestures hint
 * (SPEC-DESKTOP-FLOATING, option A, 8). Storage can be blocked (private
 * windows, site data off): then the hint counts as not dismissed, and
 * dismissing it lasts until the page reloads.
 */
const STORAGE_KEY = 'bmuster.desktop.gestureHint';

export function hintDismissed(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) === 'dismissed';
	} catch {
		return false;
	}
}

export function dismissHint(): void {
	try {
		localStorage.setItem(STORAGE_KEY, 'dismissed');
	} catch {
		// A per-viewer convenience; the hint shows again on the next visit.
	}
}
