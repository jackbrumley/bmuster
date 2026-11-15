/**
 * Files sent through a desktop session (SPEC-SESSION-FILES): the shapes the
 * server and the browser share. Must match
 * agent/crates/protocol/src/user_files.rs.
 */

/** Files in one drop at most. */
export const MAX_FILES_PER_DROP = 100;

/** Bytes that must stay free on the machine's Downloads disk. */
const KEEP_FREE_BYTES = 1024 * 1024 * 1024;

/** Why the agent refused a request (`UserFilesError`). */
export const SESSION_FILE_ERROR_CODES = [
	'invalid',
	'nobody',
	'locked',
	'not-owned',
	'denied',
	'no-space',
	'quota',
	'offset',
	'mismatch',
	'too-big',
	'busy',
	'io'
] as const;

export type SessionFileErrorCode = (typeof SESSION_FILE_ERROR_CODES)[number];

/** Where sent files go, or why they cannot be sent now. */
export type SendTarget =
	| { kind: 'ready'; user: string; folderLabel: string; free: number }
	| { kind: 'refused'; message: string };

export type TransferDirection = 'to-machine' | 'from-machine';

export type TransferState =
	| { kind: 'running' }
	| { kind: 'done'; savedAs: string }
	| { kind: 'failed'; message: string }
	| { kind: 'cancelled' };

/** One row of the Transfers panel (SPEC-SESSION-FILES 3.3). */
export type TransferRow = {
	id: string;
	direction: TransferDirection;
	name: string;
	size: number;
	bytes: number;
	startedIso: string;
	state: TransferState;
};

/** "Send at most 100 files at once.", or why a dropped set cannot go, before anything is sent. */
export function dropProblem(
	files: readonly { name: string; size: number; isFolder: boolean }[],
	limits: { maxBytes: number; maxGb: number; free: number }
): string | undefined {
	if (files.some((file) => file.isFolder)) {
		return "Folders can't be sent yet. Zip the folder, or send the files inside it.";
	}
	if (files.length > MAX_FILES_PER_DROP) {
		return `Send at most ${MAX_FILES_PER_DROP} files at once.`;
	}
	const big = files.find((file) => file.size > limits.maxBytes);
	if (big !== undefined) {
		return `${big.name} is ${sizeText(big.size)}; files can be at most ${limits.maxGb} GB (Settings → Files).`;
	}
	const total = files.reduce((sum, file) => sum + file.size, 0);
	if (total + KEEP_FREE_BYTES > limits.free) {
		return `There isn't enough room on the machine: ${sizeText(limits.free)} free, these files need ${sizeText(total)} and 1 GB must stay free.`;
	}
	return undefined;
}

/** A size for people: `4.1 GB`, `12 MB`, `512 bytes`. */
export function sizeText(bytes: number): string {
	const gb = 1024 * 1024 * 1024;
	const mb = 1024 * 1024;
	if (bytes >= gb) {
		return `${(bytes / gb).toFixed(1)} GB`;
	}
	if (bytes >= mb) {
		return `${(bytes / mb).toFixed(1)} MB`;
	}
	if (bytes >= 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${bytes} bytes`;
}

/** The browser notice for a finished drop (SPEC-SESSION-FILES 3.1, SF17). */
export function sentNotice(
	results: readonly (
		{ kind: 'saved'; name: string } | { kind: 'failed'; name: string; message: string }
	)[],
	where: { user: string; folderLabel: string; machine: string }
): { tone: 'success' | 'error'; text: string } {
	const saved = results.filter((result) => result.kind === 'saved');
	const failed = results.flatMap((result) => (result.kind === 'failed' ? [result] : []));
	const place = `${where.user}'s ${where.folderLabel} on ${where.machine}`;
	if (failed.length === 0) {
		const what = saved.length === 1 ? (saved[0]?.name ?? '') : `${saved.length} files`;
		return { tone: 'success', text: `Sent ${what} to ${place}.` };
	}
	const reasons = failed.map((result) => `${result.name}: ${result.message}`).join(' ');
	return {
		tone: 'error',
		text:
			saved.length === 0
				? `Nothing was sent to ${place}. ${reasons}`
				: `Sent ${saved.length} of ${results.length} files to ${place}. ${reasons}`
	};
}
