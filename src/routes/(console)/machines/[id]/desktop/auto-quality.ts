import type { AutoLevel } from '#lib/domain/desktop/messages.ts';

/**
 * Where Auto starts on this machine (SPEC-DESKTOP 20). The agent picks the
 * level as it goes and says which; this browser remembers, per machine,
 * whether the last session held Extra high, so the next one starts there
 * instead of climbing to it again. Storage can be blocked (private
 * windows, site data off): then every session starts at High.
 */

/** The levels a session starts at: High, or Extra high once a session held it. */
export type AutoStart = Extract<AutoLevel, 'high' | 'extra-high'>;

/** Auto has to hold a level this long before it counts as what the link sustains. */
export const SUSTAINED_MS = 20_000;

const STORAGE_PREFIX = 'bmuster.desktop.autoStart.';

/**
 * The start to remember once Auto has held `level` since `sinceMs`, or
 * undefined while it has not held it long enough to tell.
 */
export function sustainedStart(
	level: AutoLevel,
	sinceMs: number,
	nowMs: number
): AutoStart | undefined {
	if (nowMs - sinceMs < SUSTAINED_MS) {
		return undefined;
	}
	return level === 'extra-high' ? 'extra-high' : 'high';
}

export function readAutoStart(machineId: string): AutoStart {
	try {
		return localStorage.getItem(STORAGE_PREFIX + machineId) === 'extra-high'
			? 'extra-high'
			: 'high';
	} catch {
		return 'high';
	}
}

export function saveAutoStart(machineId: string, start: AutoStart): void {
	try {
		localStorage.setItem(STORAGE_PREFIX + machineId, start);
	} catch {
		// A per-viewer convenience: the next session climbs from High instead.
	}
}
