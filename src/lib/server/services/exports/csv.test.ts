import { describe, expect, it } from 'vitest';
import { csvCell, csvLine, csvResponse } from './csv.ts';

describe('CSV quoting (X3)', () => {
	it('leaves plain text and numbers alone, and writes null as an empty cell', () => {
		expect(csvCell('Reception PC')).toBe('Reception PC');
		expect(csvCell(42)).toBe('42');
		expect(csvCell(-3.5)).toBe('-3.5');
		expect(csvCell(null)).toBe('');
		expect(csvCell('')).toBe('');
	});

	it('quotes a cell with a comma, quote, CR or LF, doubling quotes inside', () => {
		expect(csvCell('Smith, Ann')).toBe('"Smith, Ann"');
		expect(csvCell('the "big" one')).toBe('"the ""big"" one"');
		expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
		expect(csvCell('a\r\nb')).toBe('"a\r\nb"');
	});

	it('joins a line with commas and ends it with CRLF', () => {
		expect(csvLine(['a', 1, null, 'b,c'])).toBe('a,1,,"b,c"\r\n');
	});

	it('refuses a number that is not finite rather than writing NaN', () => {
		expect(() => csvCell(Number.NaN)).toThrow(/finite/);
	});
});

describe('CSV injection guard (X4)', () => {
	it('prefixes text starting with = + - @ tab or CR with a single quote', () => {
		expect(csvCell('=HYPERLINK("http://evil.example","x")')).toBe(
			`"'=HYPERLINK(""http://evil.example"",""x"")"`
		);
		expect(csvCell('+61 400 000 000')).toBe("'+61 400 000 000");
		expect(csvCell('-2+3')).toBe("'-2+3");
		expect(csvCell('@SUM(A1:A2)')).toBe("'@SUM(A1:A2)");
		expect(csvCell('\t=1+1')).toBe("'\t=1+1");
		expect(csvCell('\r=1+1')).toBe(`"'\r=1+1"`);
	});

	it('leaves those characters alone anywhere but the start, and leaves numbers as numbers', () => {
		expect(csvCell('a=b')).toBe('a=b');
		expect(csvCell('user@example.com')).toBe('user@example.com');
		expect(csvCell(-5)).toBe('-5');
	});
});

describe('CSV download (X2)', () => {
	it('is an attachment in UTF-8 with a byte order mark and CRLF lines', async () => {
		const response = csvResponse({
			filename: 'bmuster-test-2026-11-07.csv',
			header: ['Name', 'Count'],
			rows: [
				['Café', 1],
				['Zoë', 2]
			]
		});
		expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
		expect(response.headers.get('content-disposition')).toBe(
			'attachment; filename="bmuster-test-2026-11-07.csv"'
		);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const bytes = new Uint8Array(await response.arrayBuffer());
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
		expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.slice(3))).toBe(
			'Name,Count\r\nCafé,1\r\nZoë,2\r\n'
		);
	});

	it('sends every row of a long export, in order, across chunks', async () => {
		const rows = Array.from({ length: 2500 }, (_, index) => [index]);
		const text = await csvResponse({ filename: 'x.csv', header: ['n'], rows }).text();
		const lines = text.replace('﻿', '').trimEnd().split('\r\n');
		expect(lines).toHaveLength(2501);
		expect(lines.at(-1)).toBe('2499');
	});
});
