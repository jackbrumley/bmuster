import type { RequestEvent } from '@sveltejs/kit';
import type { CaughtError } from '@sveltejs/kit/hooks';
import { describe, expect, it } from 'vitest';
import { UNEXPECTED_ERROR_MESSAGE } from '#lib/domain/errors/error-copy.ts';
import { errorReference, serverErrorHandler } from './handle-error.ts';

/** Just enough of a RequestEvent for the hook, which reads only the method and path. */
function event(method: string, path: string): RequestEvent {
	const partial: Pick<RequestEvent, 'request' | 'url'> = {
		request: new Request(`https://bmuster.test${path}`, { method }),
		url: new URL(`https://bmuster.test${path}`)
	};
	return partial as RequestEvent;
}

function handler() {
	const lines: string[] = [];
	const handle = serverErrorHandler(
		(line) => lines.push(line),
		() => 'ab12cd34'
	);
	return {
		lines,
		run: (caught: CaughtError, path = '/machines') =>
			handle({ ...caught, event: event('GET', path) })
	};
}

describe('server error hook (SPEC-ERROR-PAGES E5)', () => {
	it('logs an unexpected error with its stack under a reference, and sends only the reference', () => {
		const { lines, run } = handler();
		const thrown = new Error('database is locked: /var/lib/bmuster/bmuster.db');
		const reply = run({ kind: 'unknown', error: thrown });
		expect(reply).toEqual({
			status: 500,
			message: UNEXPECTED_ERROR_MESSAGE,
			reference: 'ab12cd34'
		});
		expect(JSON.stringify(reply)).not.toContain('database is locked');
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain('Error ab12cd34: GET /machines: Error: database is locked');
		expect(lines[0]).toContain('handle-error.test.ts');
	});

	it('logs things thrown that are not Errors too', () => {
		const { lines, run } = handler();
		expect(run({ kind: 'unknown', error: 'plain string' })).toMatchObject({
			reference: 'ab12cd34'
		});
		expect(lines).toEqual(['Error ab12cd34: GET /machines: plain string']);
	});

	it('leaves expected errors as they are, unlogged', () => {
		const { lines, run } = handler();
		expect(
			run({ kind: 'app', error: { status: 403, message: 'Only admins can open this page.' } })
		).toEqual({});
		expect(
			run({ kind: 'framework', error: { status: 404, message: 'Not Found' } }, '/nope')
		).toEqual({});
		expect(lines).toEqual([]);
	});

	it("logs SvelteKit's own server errors with a reference", () => {
		const { lines, run } = handler();
		expect(run({ kind: 'framework', error: { status: 500, message: 'Internal Error' } })).toEqual({
			reference: 'ab12cd34'
		});
		expect(lines).toEqual(['Error ab12cd34: GET /machines: Internal Error']);
	});

	it('makes short, distinct references', () => {
		const references = new Set(Array.from({ length: 50 }, errorReference));
		expect(references.size).toBe(50);
		for (const reference of references) {
			expect(reference).toMatch(/^[0-9a-f]{8}$/);
		}
	});
});

describe('share link tokens stay out of the log (SPEC-SHARE-LINKS)', () => {
	it('SL19: redacts the token from /s/<token> paths', () => {
		const { lines, run } = handler();
		expect(
			run(
				{ kind: 'unknown', error: 'boom' },
				'/s/abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ/session'
			)
		).toMatchObject({ reference: 'ab12cd34' });
		expect(lines).toEqual(['Error ab12cd34: GET /s/…/session: boom']);
	});
});
