import { describe, expect, it } from 'vitest';
import {
	detectComputer,
	formatSupportCode,
	scamCheck,
	supportCodeDigits,
	textWithLinks
} from './phone-support.ts';

describe('enrolment codes (SPEC-JOIN)', () => {
	it('reads an enrolment code out in two groups, and accepts it typed with spaces or a hyphen', () => {
		expect(formatSupportCode('482913')).toBe('482 913');
		expect(supportCodeDigits(' 482 913 ')).toBe('482913');
		expect(supportCodeDigits('482-913')).toBe('482913');
		expect(supportCodeDigits('48291')).toBeUndefined();
		expect(supportCodeDigits('48291x')).toBeUndefined();
	});

	it('J7: stops at the first unsafe answer, and is safe only when all three are safe', () => {
		expect(scamCheck({ contacted: null, money: null, virus: null })).toEqual({
			kind: 'answering'
		});
		expect(scamCheck({ contacted: 'yes', money: 'no', virus: null })).toEqual({
			kind: 'answering'
		});
		expect(scamCheck({ contacted: 'yes', money: 'no', virus: 'no' })).toEqual({ kind: 'safe' });
		expect(scamCheck({ contacted: 'no', money: null, virus: null })).toEqual({
			kind: 'stop',
			question: 'contacted'
		});
		expect(scamCheck({ contacted: 'yes', money: 'yes', virus: 'no' })).toEqual({
			kind: 'stop',
			question: 'money'
		});
		expect(scamCheck({ contacted: null, money: null, virus: 'yes' })).toEqual({
			kind: 'stop',
			question: 'virus'
		});
	});

	it('J9: tells the computer from its user agent, and a phone from a computer', () => {
		expect(
			detectComputer(
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
			)
		).toBe('windows');
		expect(
			detectComputer(
				'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0'
			)
		).toBe('linux');
		expect(
			detectComputer(
				'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Safari/605.1.15'
			)
		).toBe('macos');
		expect(
			detectComputer(
				'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'
			)
		).toBe('phone');
		expect(
			detectComputer(
				'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'
			)
		).toBe('phone');
	});

	it('J11: splits web addresses out of the report advice, leaving trailing punctuation as text', () => {
		expect(
			textWithLinks(
				'Report it to Scamwatch: https://www.scamwatch.gov.au/report-a-scam, or call ReportCyber on 1300 292 371.'
			)
		).toEqual([
			{ kind: 'text', text: 'Report it to Scamwatch: ' },
			{ kind: 'link', href: 'https://www.scamwatch.gov.au/report-a-scam' },
			{ kind: 'text', text: ', or call ReportCyber on 1300 292 371.' }
		]);
		expect(textWithLinks('See https://example.org.')).toEqual([
			{ kind: 'text', text: 'See ' },
			{ kind: 'link', href: 'https://example.org' },
			{ kind: 'text', text: '.' }
		]);
		expect(textWithLinks('No links, and http://plain.example is not one.')).toEqual([
			{ kind: 'text', text: 'No links, and http://plain.example is not one.' }
		]);
	});
});
