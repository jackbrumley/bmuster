import type { ServerUpdateView } from '#lib/schemas/releases/server-updates.ts';

/**
 * Whether the console frame shows "BMuster X is available" (SPEC-SERVER-UPDATES
 * SU13): only when a newer release is waiting and nothing is being done about
 * it yet. Never on the Updates page, which shows the release itself, and never
 * while an update is requested or running.
 */
export function showsUpdateNotice(
	view: ServerUpdateView | null,
	page: 'updates' | 'other'
): view is ServerUpdateView & { release: NonNullable<ServerUpdateView['release']> } {
	if (view === null) return false;
	if (view.release === null || page === 'updates') return false;
	switch (view.operation.phase) {
		case 'idle':
		case 'up-to-date':
		case 'healthy':
		case 'rolled-back':
		case 'failed':
			return true;
		case 'requested':
		case 'checking':
		case 'downloading':
		case 'switching':
		case 'starting':
			return false;
	}
}

/**
 * The Updates page's note about the last server update (SPEC-SERVER-UPDATES SU16): shown only
 * while one runs or when it needs attention. A healthy or quiet updater shows nothing, because
 * the installed version is already on the panel.
 */
export function updateOperationNotice(
	phase: ServerUpdateView['operation']['phase']
): { tone: 'info' | 'warning'; title: string } | undefined {
	switch (phase) {
		case 'idle':
		case 'up-to-date':
		case 'healthy':
			return undefined;
		case 'requested':
		case 'checking':
		case 'downloading':
		case 'switching':
		case 'starting':
			return { tone: 'info', title: 'Updating the server' };
		case 'rolled-back':
			return { tone: 'warning', title: 'The update was rolled back' };
		case 'failed':
			return { tone: 'warning', title: 'The server update failed' };
	}
}
