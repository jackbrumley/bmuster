/**
 * Cards or Table on the Machines page. The person's pick is kept in this
 * browser only (localStorage); until they pick, a small fleet shows cards
 * and a large one the table.
 */
export type MachinesView = 'cards' | 'table';

/** Cards up to this many machines, the table above it. */
const CARDS_UP_TO = 50;

const STORAGE_KEY = 'bmuster-machines-view';

export function defaultView(machineCount: number): MachinesView {
	return machineCount > CARDS_UP_TO ? 'table' : 'cards';
}

/**
 * The view this browser picked before, or undefined. Storage can be blocked
 * (private windows, site data off), and then the page simply uses the default.
 */
export function readSavedView(): MachinesView | undefined {
	try {
		const value = localStorage.getItem(STORAGE_KEY);
		return value === 'cards' || value === 'table' ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Remembers the pick; when storage is blocked it lasts until the page is left. */
export function saveView(view: MachinesView): void {
	try {
		localStorage.setItem(STORAGE_KEY, view);
	} catch {
		// Blocked storage only costs remembering the pick next time.
	}
}
