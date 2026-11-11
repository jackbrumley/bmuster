const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 1536 → "1.5 KB". Uses 1024 steps, like the operating systems show. */
export function formatBytes(bytes: number): string {
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
		value /= 1024;
		unit += 1;
	}
	const digits = value >= 100 || unit === 0 ? 0 : 1;
	return `${value.toFixed(digits)} ${BYTE_UNITS[unit] ?? 'B'}`;
}

/** Whole-number percentage of used out of total, clamped to 0–100. */
export function percentOf(used: number, total: number): number {
	if (total <= 0) {
		return 0;
	}
	return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
}

/** "just now", "5 min ago", "3 h ago", "2 days ago". */
export function formatRelative(iso: string, now: number): string {
	const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
	if (seconds < 60) {
		return 'just now';
	}
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) {
		return `${minutes} min ago`;
	}
	const hours = Math.round(minutes / 60);
	if (hours < 48) {
		return `${hours} h ago`;
	}
	return `${Math.round(hours / 24)} days ago`;
}

/** How long something has been running: "under a minute", "12 min", "5 h 12 min", "3 days 4 h". */
export function formatDuration(totalSeconds: number): string {
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 1) {
		return 'under a minute';
	}
	if (minutes < 60) {
		return `${minutes} min`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		const rest = minutes % 60;
		return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
	}
	const days = Math.floor(hours / 24);
	const rest = hours % 24;
	const dayWords = `${days} ${days === 1 ? 'day' : 'days'}`;
	return rest === 0 ? dayWords : `${dayWords} ${rest} h`;
}
