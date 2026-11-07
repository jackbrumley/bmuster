import { describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { fallback } from './+server.ts';

type Event = Parameters<typeof fallback>[0];
function request(session: App.Locals['session']): Event {
	const partial: Pick<RequestEvent, 'locals'> = { locals: { session } };
	return partial as Event;
}

describe('E4: unknown API endpoints', () => {
	it('requires sign-in before answering an unknown endpoint', async () => {
		const response = await fallback(request({ kind: 'none' }));
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ message: 'Sign in first.' });
	});

	it('returns JSON 404 to a signed-in member instead of an HTML error page', async () => {
		const response = await fallback(
			request({
				kind: 'signed-in',
				user: {
					id: 'member',
					name: 'Member',
					email: 'member@example.test',
					role: 'member'
				}
			})
		);
		expect(response.status).toBe(404);
		expect(response.headers.get('content-type')).toContain('application/json');
		expect(await response.json()).toEqual({ message: 'No such API endpoint.' });
	});
});
