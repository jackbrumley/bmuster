/**
 * Dynamic Client Registration is open to anyone, so it is rate-limited per address (SPEC-MCP M6):
 * at most 10 registrations an hour. Kept in memory: a restart forgets it, which costs no more
 * than another hour's allowance, and registering grants nothing.
 */
const WINDOW_MS = 60 * 60_000;
const MAX_PER_WINDOW = 10;

const recent = new Map<string, number[]>();

/** Counts this registration and says whether it may go ahead. */
export function registrationAllowed(address: string, now: number): boolean {
	const kept = (recent.get(address) ?? []).filter((at) => now - at < WINDOW_MS);
	if (kept.length >= MAX_PER_WINDOW) {
		recent.set(address, kept);
		return false;
	}
	kept.push(now);
	recent.set(address, kept);
	if (recent.size > 10_000) {
		for (const [key, times] of recent) {
			if (times.every((at) => now - at >= WINDOW_MS)) recent.delete(key);
		}
	}
	return true;
}
