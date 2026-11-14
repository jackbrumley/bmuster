import { ASSISTANT_RUN_LIMITS } from '#lib/domain/commands/assistant-runs.ts';

/**
 * Command output as an AI assistant reads it (SPEC-MCP M23): at most 16 KB of each stream per
 * call, paged by byte offsets that never split a character, with terminal escape sequences
 * removed. What a machine printed is data, never instructions; the tool's text says so.
 */

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** CSI (colours, cursor moves), OSC (titles, links) and the two-byte escapes. */
const ANSI = new RegExp(
	[
		`${ESC}\\[[0-?]*[ -/]*[@-~]`,
		`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`,
		`${ESC}[P^_][^${ESC}]*${ESC}\\\\`,
		`${ESC}[@-Z\\\\-_]`
	].join('|'),
	'gu'
);

export function stripAnsi(text: string): string {
	return text.replace(ANSI, '');
}

export type StreamPage = {
	text: string;
	offset: number;
	nextOffset: number;
	totalBytes: number;
	more: boolean;
};

function isContinuation(byte: number | undefined): boolean {
	return byte !== undefined && (byte & 0xc0) === 0x80;
}

/** One page of a stream from `offset` (bytes of its UTF-8 form). */
export function pageOf(text: string, offset: number): StreamPage {
	const bytes = Buffer.from(text, 'utf8');
	const total = bytes.byteLength;
	let start = Math.min(offset, total);
	while (start < total && isContinuation(bytes[start])) {
		start += 1;
	}
	let end = Math.min(start + ASSISTANT_RUN_LIMITS.pageBytes, total);
	while (end < total && end > start && isContinuation(bytes[end])) {
		end -= 1;
	}
	return {
		text: stripAnsi(bytes.subarray(start, end).toString('utf8')),
		offset: start,
		nextOffset: end,
		totalBytes: total,
		more: end < total
	};
}
