/** How long a server update usually takes, start to reload (SPEC-SERVER-UPDATES SU14). */
const USUAL_UPDATE_MS = 60_000;

/**
 * The countdown under the radar while the server updates: the seconds left of
 * the usual minute, then a plain word that it is taking longer, since the page
 * reloads by itself either way.
 */
export function updateWaitLine(elapsedMs: number): string {
	const left = Math.ceil((USUAL_UPDATE_MS - Math.max(0, elapsedMs)) / 1000);
	if (left > 1) return `About ${String(left)} seconds left`;
	if (left === 1) return 'About 1 second left';
	return 'Taking a little longer than usual';
}
