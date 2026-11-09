import { compareAgentVersions } from '#lib/domain/machines/agent-version.ts';
import type { ServerUpdateView } from '#lib/schemas/releases/server-updates.ts';
import type { ApiResult } from '#lib/utils/api-client.ts';

const FIRST_RETRY_MS = 1000;
const MAX_RETRY_MS = 5000;

export type RestartReturn =
	{ kind: 'ready'; view: ServerUpdateView } | { kind: 'failed'; view: ServerUpdateView };

export function startServerRestartMonitor(options: {
	expectedVersion: string;
	read: () => Promise<ApiResult<ServerUpdateView>>;
	onReturned: (result: RestartReturn) => void;
}): { checkNow: () => void; stop: () => void } {
	let stopped = false;
	let checking = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let retryMs = FIRST_RETRY_MS;

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
				schedule();
				return;
			}
			const view = result.data;
			if (view.operation.phase === 'failed' || view.operation.phase === 'rolled-back') {
				stop();
				options.onReturned({ kind: 'failed', view });
				return;
			}
			if (
				view.operation.phase === 'updated' &&
				compareAgentVersions(view.installedVersion, options.expectedVersion) >= 0
			) {
				stop();
				options.onReturned({ kind: 'ready', view });
				return;
			}
			schedule();
		} catch {
			schedule();
		} finally {
			checking = false;
		}
	}

	void checkNow();
	return { checkNow: () => void checkNow(), stop };
}
