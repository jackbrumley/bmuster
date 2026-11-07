import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isHttpError, isRedirect, type RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { scanRouteGuards } from '../../../../scripts/hygiene/route-guards.ts';
import { page } from './page.ts';
import { route } from './route.ts';

const ADMIN: ConsoleUser = { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'admin' };
const MEMBER: ConsoleUser = { id: 'm', name: 'Mo', email: 'mo@example.com', role: 'member' };

type Who = { kind: 'none' } | { kind: 'signed-in'; user: ConsoleUser };

/** Just enough of a RequestEvent for the guards, which read only locals, url and request. */
function event(
	who: Who,
	path: string,
	request = new Request(`https://bmuster.test${path}`)
): RequestEvent {
	const partial: Pick<RequestEvent, 'locals' | 'url' | 'request'> = {
		locals: { session: who },
		url: new URL(`https://bmuster.test${path}`),
		request
	};
	return partial as RequestEvent;
}

function thrown(run: () => unknown): unknown {
	try {
		run();
	} catch (error) {
		return error;
	}
	throw new Error('expected a throw');
}

const ok = () => Response.json({ ok: true });

describe('endpoint guards (S7)', () => {
	it('refuses a request without a session with 401', async () => {
		for (const guarded of [route.user(ok), route.admin(ok)]) {
			const response = await guarded(event({ kind: 'none' }, '/api/users'));
			expect(response.status).toBe(401);
		}
	});

	it('refuses a member on an admin endpoint with 403, and lets an admin through', async () => {
		expect(
			(await route.admin(ok)(event({ kind: 'signed-in', user: MEMBER }, '/api/users'))).status
		).toBe(403);
		expect(
			(await route.admin(ok)(event({ kind: 'signed-in', user: ADMIN }, '/api/users'))).status
		).toBe(200);
		expect(
			(await route.user(ok)(event({ kind: 'signed-in', user: MEMBER }, '/logout'))).status
		).toBe(200);
	});

	it('hands the handler only what the guard proved', async () => {
		const response = await route.admin((_event, { user }) => Response.json({ id: user.id }))(
			event({ kind: 'signed-in', user: ADMIN }, '/api/users')
		);
		expect(await response.json()).toEqual({ id: 'a' });
	});

	it('keeps agents on their own signed check, never a cookie', async () => {
		const request = new Request('https://bmuster.test/agent/v1/check-in', {
			method: 'POST',
			body: '{}'
		});
		const response = await route.agent(ok)(
			event({ kind: 'signed-in', user: ADMIN }, '/agent/v1/check-in', request)
		);
		expect(response.status).toBe(401);
		expect(await response.json()).toMatchObject({ reason: 'bad-signature' });
	});
});

describe('page guards (S7)', () => {
	it('sends a signed-out visitor to sign in, and back afterwards', () => {
		const redirect = thrown(() => page.user(() => ({}))(event({ kind: 'none' }, '/users?tab=2')));
		if (!isRedirect(redirect)) throw new Error('expected a redirect');
		expect(redirect.location).toBe(`/login?returnTo=${encodeURIComponent('/users?tab=2')}`);
	});

	it('refuses a member on an admin page with 403', () => {
		const refused = thrown(() =>
			page.admin(() => ({}))(event({ kind: 'signed-in', user: MEMBER }, '/users'))
		);
		expect(isHttpError(refused, 403)).toBe(true);
		expect(page.admin(() => 'loaded')(event({ kind: 'signed-in', user: ADMIN }, '/users'))).toBe(
			'loaded'
		);
	});
});

/** Every route file under src/routes. */
function routeFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? routeFiles(path) : [path];
	});
}

describe('every route is guarded (S7, hygiene route-guard-required)', () => {
	const files = routeFiles('src/routes');
	const text = (path: string): string => readFileSync(path, 'utf8');

	it('has no unguarded handler anywhere', () => {
		const problems = files.flatMap((path) =>
			scanRouteGuards(path, text(path)).map((issue) => `${path}: ${issue}`)
		);
		expect(problems).toEqual([]);
	});

	it('puts every /api route and the console behind a session, and admin areas behind the admin role', () => {
		const api = files.filter(
			(path) => path.startsWith('src/routes/api/') && path.endsWith('+server.ts')
		);
		expect(api.length).toBeGreaterThan(0);
		for (const path of api) {
			expect(text(path), path).not.toMatch(/route\.(public|agent)\(/);
		}
		for (const path of [
			'src/routes/api/users/+server.ts',
			'src/routes/api/users/[id=uuid]/+server.ts',
			'src/routes/api/identity-providers/+server.ts',
			'src/routes/api/identity-providers/[id=uuid]/+server.ts',
			'src/routes/api/settings/+server.ts',
			'src/routes/api/join-codes/+server.ts'
		]) {
			expect(text(path), path).toMatch(/route\.admin\(/);
			expect(text(path), path).not.toMatch(/route\.user\(/);
		}
		expect(text('src/routes/(console)/+layout.server.ts')).toMatch(/page\.user\(/);
		for (const area of ['users', 'sign-in', 'settings', 'activity', 'groups', 'access', 'add']) {
			expect(text(`src/routes/(console)/${area}/+page.server.ts`), area).toMatch(/page\.admin\(/);
		}
	});

	it('leaves agent routes on their own checks', () => {
		expect(text('src/routes/agent/v1/check-in/+server.ts')).toMatch(/route\.agent\(/);
		for (const path of [
			'src/routes/agent/v1/enrol/+server.ts',
			'src/routes/install.sh/+server.ts',
			'src/routes/install.ps1/+server.ts'
		]) {
			expect(text(path), path).toMatch(/route\.public\(/);
		}
	});
});
