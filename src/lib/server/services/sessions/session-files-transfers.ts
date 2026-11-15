import type {
	TransferDirection,
	TransferRow,
	TransferState
} from '#lib/domain/session-files/session-files.ts';

/**
 * The Transfers panel's list (SPEC-SESSION-FILES 3.3), in server memory only: per person per
 * machine, each transfer kept for an hour after it ends, so it comes back after a reload. The
 * database keeps the audit, never this list.
 */

/** A finished transfer stays listed this long. */
const KEEP_MS = 60 * 60_000;

export type Transfer = {
	id: string;
	direction: TransferDirection;
	userId: string;
	machineId: string;
	desktopSessionId: string;
	batchId: string;
	name: string;
	size: number;
	bytes: number;
	startedAt: number;
	endedAt: number | undefined;
	state: TransferState;
	/** The machine's person and folder, for the notice and the audit. */
	place: { user: string; folderLabel: string };
};

export type TransferStore = ReturnType<typeof createTransferStore>;

export function createTransferStore() {
	const transfers = new Map<string, Transfer>();

	function prune(now: number): void {
		for (const [id, transfer] of transfers) {
			if (transfer.endedAt !== undefined && now - transfer.endedAt > KEEP_MS) {
				transfers.delete(id);
			}
		}
	}

	return {
		add(transfer: Transfer): void {
			prune(transfer.startedAt);
			transfers.set(transfer.id, transfer);
		},

		/** This person's transfer on this machine, or nothing (never someone else's). */
		find(userId: string, machineId: string, id: string): Transfer | undefined {
			const found = transfers.get(id);
			return found?.userId === userId && found.machineId === machineId ? found : undefined;
		},

		/** Ends a transfer; true when it was still running. */
		end(transfer: Transfer, state: Exclude<TransferState, { kind: 'running' }>, now: number) {
			if (transfer.state.kind !== 'running') {
				return false;
			}
			transfer.state = state;
			transfer.endedAt = now;
			return true;
		},

		inBatch(userId: string, batchId: string): Transfer[] {
			return [...transfers.values()].filter(
				(transfer) => transfer.userId === userId && transfer.batchId === batchId
			);
		},

		/** The panel's rows, newest first. */
		rows(userId: string, machineId: string, now: number): TransferRow[] {
			prune(now);
			// Later additions first when two started in the same millisecond.
			return [...transfers.values()]
				.reverse()
				.filter((transfer) => transfer.userId === userId && transfer.machineId === machineId)
				.sort((a, b) => b.startedAt - a.startedAt)
				.map((transfer) => ({
					id: transfer.id,
					direction: transfer.direction,
					name: transfer.name,
					size: transfer.size,
					bytes: transfer.bytes,
					startedIso: new Date(transfer.startedAt).toISOString(),
					state: transfer.state
				}));
		}
	};
}

/** Kept on globalThis, like the relay: every copy of this module must share the list. */
const STORE_KEY = Symbol.for('bmuster.session-file-transfers');

export function transferStore(): TransferStore {
	const existing: unknown = Reflect.get(globalThis, STORE_KEY);
	if (isStore(existing)) {
		return existing;
	}
	const created = createTransferStore();
	Reflect.set(globalThis, STORE_KEY, created);
	return created;
}

function isStore(value: unknown): value is TransferStore {
	return (
		typeof value === 'object' &&
		value !== null &&
		'rows' in value &&
		typeof value.rows === 'function'
	);
}
