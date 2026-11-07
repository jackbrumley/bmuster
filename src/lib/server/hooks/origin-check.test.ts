import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { isCrossOriginWrite, originCheck } from './origin-check.ts';

const SELF = 'https://bmuster.test';

function request(method: string, path: string, origin: string | null): Request {
	const headers = new Headers({ 'content-type': 'application/json' });
	if (origin !== null) headers.set('origin', origin);
	return new Request(`${SELF}${path}`, { method, headers, body: method === 'GET' ? null : '{}' });
}

describe('origin check (S8)', () => {
	it('refuses state-changing requests from another origin, or with no origin', () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			expect(
				isCrossOriginWrite(
					request(method, '/api/users', 'https://evil.example'),
					new URL(`${SELF}/api/users`)
				),
				method
			).toBe(true);
			expect(
				isCrossOriginWrite(request(method, '/api/users', null), new URL(`${SELF}/api/users`)),
				method
			).toBe(true);
			expect(
				isCrossOriginWrite(request(method, '/api/users', SELF), new URL(`${SELF}/api/users`)),
				method
			).toBe(false);
		}
	});

	it('lets reads through, and leaves signed agent requests to their own check', () => {
		expect(
			isCrossOriginWrite(
				request('GET', '/api/users', 'https://evil.example'),
				new URL(`${SELF}/api/users`)
			)
		).toBe(false);
		expect(
			isCrossOriginWrite(
				request('POST', '/agent/v1/check-in', null),
				new URL(`${SELF}/agent/v1/check-in`)
			)
		).toBe(false);
	});

	it('answers 403 before the route runs', async () => {
		const partial: Pick<RequestEvent, 'request' | 'url'> = {
			request: request('POST', '/logout', 'https://evil.example'),
			url: new URL(`${SELF}/logout`)
		};
		let reached = false;
		const response = await originCheck({
			event: partial as RequestEvent,
			resolve: () => {
				reached = true;
				return Promise.resolve(new Response('ok'));
			}
		});
		expect(response.status).toBe(403);
		expect(reached).toBe(false);
	});
});
