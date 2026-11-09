import { compareAgentVersions } from '#lib/domain/machines/agent-version.ts';
import type { ServerUpdateView } from '#lib/schemas/releases/server-updates.ts';
import type { ApiResult } from '#lib/utils/api-client.ts';

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 5000;
/** The root updater's results that end its run without the new version (SPEC-SERVER-UPDATES). */
const ENDED_WITHOUT_UPDATE = new Set(['failed', 'rolled-back', 'up-to-date']);

/** What the Updates page shows under its veil while it waits: the updater's step, or a gap. */
export type RestartProgress = { kind: 'step'; message: string } | { kind: 'unreachable' };

export type RestartReturn =
	{ kind: 'ready'; view: ServerUpdateView } | { kind: 'failed'; view: ServerUpdateView };

/**
 * After Update now: polls the update view through restarts and proxy errors until the root
 * updater reports a result written after `requestedAtIso` (an older one belongs to an earlier
 * update): the expected version healthy, or the run ended without it.
 */
export function startServerRestartMonitor(options: {
	expectedVersion: string;
	requestedAtIso: string;
	read: () => Promise<ApiResult<ServerUpdateView>>;
	onProgress: (progress: RestartProgress) => void;
	onReturned: (result: RestartReturn) => void;
}): { checkNow: () => void; stop: () => void } {
	let stopped = false;
	let checking = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let retryMs = FIRST_RETRY_MS;
	const requestedAt = Date.parse(options.requestedAtIso);

	function stop(): void {
		stopped = true;
		if (timer !== undefined) clearTimeout(timer);
	}

	function schedule(): void {
		if (stopped) return;
		timer = setTimeout(() => {
			void checkNow();
		}, retryMs);
		retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
	}

	function isStopped(): boolean {
		return stopped;
	}

	function isFromThisUpdate(view: ServerUpdateView): boolean {
		return view.operation.atIso !== null && Date.parse(view.operation.atIso) >= requestedAt;
	}

	async function checkNow(): Promise<void> {
		if (stopped || checking) return;
		if (timer !== undefined) {
			clearTimeout(timer);
			timer = undefined;
		}
		checking = true;
		try {
			const result = await options.read();
			if (isStopped()) return;
			if (!result.ok) {
				options.onProgress({ kind: 'unreachable' });
				schedule();
				return;
			}
			const view = result.data;
			if (isFromThisUpdate(view) && view.operation.message !== '') {
				options.onProgress({ kind: 'step', message: view.operation.message });
			}
			if (isFromThisUpdate(view) && ENDED_WITHOUT_UPDATE.has(view.operation.phase)) {
				stop();
				options.onReturned({ kind: 'failed', view });
				return;
			}
			if (
				isFromThisUpdate(view) &&
				view.operation.phase === 'healthy' &&
				compareAgentVersions(view.installedVersion, options.expectedVersion) >= 0
			) {
				stop();
				options.onReturned({ kind: 'ready', view });
				return;
			}
			schedule();
		} catch {
			options.onProgress({ kind: 'unreachable' });
			schedule();
		} finally {
			checking = false;
		}
	}

	void checkNow();
	return { checkNow: () => void checkNow(), stop };
}
