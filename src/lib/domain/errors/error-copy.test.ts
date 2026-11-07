import { describe, expect, it } from 'vitest';
import {
	errorCopy,
	errorDetail,
	errorPlace,
	isServerError,
	UNEXPECTED_ERROR_MESSAGE
} from './error-copy.ts';

describe('error page words (SPEC-ERROR-PAGES E1–E3)', () => {
	it('E1: gives each common status its own title', () => {
		expect(errorCopy(404, 'page').title).toBe('Page not found');
		expect(errorCopy(403, 'page').title).toBe('Not allowed');
		expect(errorCopy(401, 'page').title).toBe('Please sign in');
		expect(errorCopy(429, 'page').title).toBe('Too many tries');
		expect(errorCopy(500, 'page').title).toBe('Something went wrong');
		expect(errorCopy(503, 'page').title).toBe('Not available right now');
	});

	it('E1: falls back by class for any other status', () => {
		expect(errorCopy(502, 'page')).toEqual(errorCopy(500, 'page'));
		expect(errorCopy(405, 'page').title).toBe("That didn't work");
		expect(errorCopy(410, 'page').title).toBe("That didn't work");
	});

	it('E2: says a missing machine may be hidden, not just gone', () => {
		expect(errorCopy(404, 'machine')).toEqual({
			title: 'Machine not found',
			explanation: 'It may have been removed, or you may not have access.'
		});
		expect(errorCopy(403, 'machine').title).toBe('Not allowed');
		expect(errorPlace('/(console)/machines/[id]')).toBe('machine');
		expect(errorPlace('/(console)/machines/[id]/manage')).toBe('machine');
		expect(errorPlace('/(console)/users')).toBe('page');
		expect(errorPlace(null)).toBe('page');
	});

	it('E1: shows a message a route wrote, and hides generic ones', () => {
		expect(errorDetail(403, 'page', 'Only admins can open this page.')).toEqual({
			kind: 'message',
			text: 'Only admins can open this page.'
		});
		for (const generic of [
			'Not Found',
			'Internal Error',
			'Method Not Allowed',
			'Not found: /nope',
			'Error: 418',
			'',
			UNEXPECTED_ERROR_MESSAGE
		]) {
			expect(errorDetail(generic === 'Error: 418' ? 418 : 404, 'page', generic), generic).toEqual({
				kind: 'none'
			});
		}
		expect(errorDetail(404, 'machine', 'No machine with this id')).toEqual({ kind: 'none' });
	});

	it('offers "Try again" only for the server\'s own errors', () => {
		expect(isServerError(500)).toBe(true);
		expect(isServerError(503)).toBe(true);
		expect(isServerError(404)).toBe(false);
		expect(isServerError(429)).toBe(false);
	});
});
