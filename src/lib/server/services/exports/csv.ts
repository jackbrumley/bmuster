/**
 * CSV for the list exports (SPEC-CSV-EXPORT X2–X4): RFC 4180 quoting, CRLF
 * line ends, UTF-8 with a byte order mark so Excel reads accents correctly,
 * and a guard against formula injection.
 */

/** One cell: text, a number, or empty (null). */
export type CsvCell = string | number | null;

const BYTE_ORDER_MARK = '﻿';

const LINE_END = '\r\n';

/**
 * Text a spreadsheet would run as a formula (or treat as one after a tab or
 * CR). OWASP's list: = + - @ tab CR.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/** RFC 4180 needs quotes around a cell with a comma, quote, CR or LF. */
const NEEDS_QUOTES = /[",\r\n]/;

/** One cell as CSV text: guarded against formulas, then quoted if needed. Numbers stay numbers. */
export function csvCell(cell: CsvCell): string {
	if (cell === null) {
		return '';
	}
	if (typeof cell === 'number') {
		if (!Number.isFinite(cell)) {
			throw new Error(`CSV cell is not a finite number: ${String(cell)}`);
		}
		return String(cell);
	}
	const guarded = FORMULA_START.test(cell) ? `'${cell}` : cell;
	return NEEDS_QUOTES.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/** One line, with its CRLF. */
export function csvLine(cells: readonly CsvCell[]): string {
	return cells.map(csvCell).join(',') + LINE_END;
}

/** Lines sent per chunk of the response, so a 100 000-row export never sits whole in one string. */
const LINES_PER_CHUNK = 1000;

/** A file to download. `filename` is plain ASCII made by the server, never from the request. */
export type CsvFile = {
	filename: string;
	header: readonly string[];
	rows: readonly (readonly CsvCell[])[];
};

/** A CSV file as a download: `text/csv` with a byte order mark, sent in chunks. */
export function csvResponse({ filename, header, rows }: CsvFile): Response {
	let next = 0;
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode(BYTE_ORDER_MARK + csvLine(header)));
		},
		pull(controller) {
			if (next >= rows.length) {
				controller.close();
				return;
			}
			const chunk = rows.slice(next, next + LINES_PER_CHUNK).map(csvLine);
			next += LINES_PER_CHUNK;
			controller.enqueue(encoder.encode(chunk.join('')));
		}
	});
	return new Response(body, {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': `attachment; filename="${filename}"`,
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff'
		}
	});
}
