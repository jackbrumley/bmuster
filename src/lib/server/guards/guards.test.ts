import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isHttpError, isRedirect, type RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { scanRouteGuards } from '../../../../scripts/hygiene/route-guards.ts';
import { database as appDatabase } from '#lib/server/database/app-database.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { load as machineLayout } from '../../../routes/(console)/machines/[id]/+layout.server.ts';
import { GET as notesGet } from '../../../routes/api/machines/[id]/notes/+server.ts';
import { eq } from 'drizzle-orm';
import { users } from '../database/schema.ts';
import { createDiagnosticsToken } from '../services/auth/diagnostics-tokens.ts';
import { toConsoleUser } from '../services/users/users.ts';
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

describe('diagnostics guard (SPEC-AGENT-LOGS AL10)', () => {
	async function tokenFor(role: 'admin' | 'member'): Promise<string> {
		const owner = await addTestUser(appDatabase, {
			email: `token-${crypto.randomUUID()}@example.com`,
			role: 'admin',
			password: null
		});
		const { token } = createDiagnosticsToken(
			appDatabase,
			{ name: 'guard test', days: 1, userId: owner.id },
			Date.now()
		);
		if (role === 'member') {
			appDatabase.update(users).set({ role: 'member' }).where(eq(users.id, owner.id)).run();
		}
		return token;
	}

	function bearer(path: string, token: string, method = 'GET'): RequestEvent {
		return event(
			{ kind: 'none' },
			path,
			new Request(`https://bmuster.test${path}`, {
				method,
				headers: { authorization: `Bearer ${token}` }
			})
		);
	}

	it('AL10: a token reads diagnostics, but only with GET', async () => {
		const token = await tokenFor('admin');
		const reader = route.diagnostics((_event, { reader }) =>
			Response.json({ kind: reader.kind, role: reader.user.role })
		);
		const read = await reader(bearer('/api/diagnostics/machines', token));
		expect(read.status).toBe(200);
		expect(await read.json()).toEqual({ kind: 'token', role: 'admin' });
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			expect((await reader(bearer('/api/diagnostics/machines', token, method))).status).toBe(405);
		}
	});

	it('AL10: a token is refused on every other guard, even a GET', async () => {
		const token = await tokenFor('admin');
		for (const guarded of [route.user(ok), route.admin(ok)]) {
			expect((await guarded(bearer('/api/users', token))).status).toBe(401);
		}
		const agent = await route.agent(ok)(bearer('/agent/v1/check-in', token, 'POST'));
		expect(agent.status).toBe(401);
	});

	it('AL10: a bad, member-owned or missing token is refused; admin sessions read', async () => {
		const reader = route.diagnostics(ok);
		expect((await reader(bearer('/api/diagnostics/machines', 'bmd_wrong'))).status).toBe(401);
		const demoted = await tokenFor('member');
		expect((await reader(bearer('/api/diagnostics/machines', demoted))).status).toBe(401);
		// A header is judged alone: a bad token next to an admin's cookie is still refused.
		const withCookie = event(
			{ kind: 'signed-in', user: ADMIN },
			'/api/diagnostics/machines',
			new Request('https://bmuster.test/api/diagnostics/machines', {
				headers: { authorization: 'Bearer bmd_wrong' }
			})
		);
		expect((await reader(withCookie)).status).toBe(401);
		expect((await reader(event({ kind: 'none' }, '/api/diagnostics/machines'))).status).toBe(401);
		expect(
			(await reader(event({ kind: 'signed-in', user: MEMBER }, '/api/diagnostics/machines'))).status
		).toBe(403);
		expect(
			(await reader(event({ kind: 'signed-in', user: ADMIN }, '/api/diagnostics/machines'))).status
		).toBe(200);
	});

	it('AL10: route.diagnostics builds only GET handlers under /api/diagnostics', () => {
		const files = routeFiles('src/routes').filter((path) => path.endsWith('+server.ts'));
		const diagnostics = files.filter((path) => path.startsWith('src/routes/api/diagnostics/'));
		expect(diagnostics.length).toBeGreaterThanOrEqual(4);
		for (const path of files) {
			const text = readFileSync(path, 'utf8');
			if (diagnostics.includes(path)) {
				expect(text, path).toMatch(/export const GET: RequestHandler = route\.diagnostics\(/);
				expect(text, path).not.toMatch(/export const (POST|PUT|PATCH|DELETE)/);
			} else {
				expect(text, path).not.toMatch(/route\.diagnostics\(/);
			}
		}
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
			'src/routes/api/join-codes/+server.ts',
			'src/routes/api/join-codes/[id=uuid]/+server.ts',
			// SPEC-JOIN J1, J3
			'src/routes/api/support-codes/+server.ts',
			'src/routes/api/support-codes/[id=uuid]/+server.ts',
			'src/routes/api/machines/[id]/+server.ts',
			'src/routes/api/machines/[id]/local-code/+server.ts',
			'src/routes/api/user-groups/+server.ts',
			'src/routes/api/user-groups/[id=uuid]/+server.ts',
			'src/routes/api/machine-groups/+server.ts',
			'src/routes/api/machine-groups/[id=uuid]/+server.ts',
			'src/routes/api/access-rules/+server.ts',
			'src/routes/api/access-rules/[id=uuid]/+server.ts',
			'src/routes/api/users/[id=uuid]/groups/+server.ts',
			'src/routes/api/machines/[id]/groups/+server.ts',
			// SPEC-CSV-EXPORT X5
			'src/routes/api/exports/users/+server.ts',
			'src/routes/api/exports/groups/+server.ts',
			'src/routes/api/exports/access-rules/+server.ts'
		]) {
			expect(text(path), path).toMatch(/route\.admin\(/);
			expect(text(path), path).not.toMatch(/route\.user\(/);
		}
		expect(text('src/routes/(console)/+layout.server.ts')).toMatch(/page\.user\(/);
		for (const area of ['users', 'sign-in', 'settings', 'groups', 'access', 'add']) {
			expect(text(`src/routes/(console)/${area}/+page.server.ts`), area).toMatch(/page\.admin\(/);
		}
		expect(text('src/routes/(console)/machines/[id]/manage/+page.server.ts')).toMatch(
			/page\.admin\(/
		);
		// Open to members, narrowed by the access service (SPEC-ACCESS A6).
		for (const path of [
			'src/routes/(console)/+page.server.ts',
			'src/routes/(console)/activity/+page.server.ts',
			'src/routes/(console)/machines/[id]/+layout.server.ts',
			'src/routes/(console)/machines/[id]/notes/+page.server.ts'
		]) {
			expect(text(path), path).toMatch(/page\.user\(/);
			expect(text(path), path).toMatch(/services\/access\/access\.ts/);
		}
		// Open to members; the exports service narrows them with the access service (X5).
		for (const path of [
			'src/routes/api/exports/machines/+server.ts',
			'src/routes/api/exports/activity/+server.ts'
		]) {
			expect(text(path), path).toMatch(/route\.user\(/);
		}
		expect(text('src/lib/server/services/exports/exports.ts')).toMatch(
			/visibleMachineIds[\s\S]*activityScopeFor/
		);
	});

	it('leaves agent routes on their own checks', () => {
		for (const path of [
			'src/routes/agent/v1/check-in/+server.ts',
			'src/routes/agent/v1/leave/+server.ts',
			'src/routes/agent/v1/local-page/+server.ts',
			'src/routes/agent/v1/local-events/+server.ts'
		]) {
			expect(text(path), path).toMatch(/route\.agent\(/);
		}
		for (const path of [
			'src/routes/agent/v1/enrol/+server.ts',
			'src/routes/install.sh/+server.ts',
			'src/routes/install.ps1/+server.ts'
		]) {
			expect(text(path), path).toMatch(/route\.public\(/);
		}
	});

	it('opens only /join and its three code endpoints to anyone (SPEC-JOIN J5)', () => {
		const join = files.filter((path) => path.startsWith('src/routes/join/'));
		const guarded = join.filter((path) => /\+(page\.server|server)\.ts$/.test(path)).sort();
		expect(guarded).toEqual([
			'src/routes/join/+page.server.ts',
			'src/routes/join/check/+server.ts',
			'src/routes/join/install/+server.ts',
			'src/routes/join/stop/+server.ts'
		]);
		expect(text('src/routes/join/+page.server.ts')).toMatch(/page\.public\(/);
		for (const path of guarded.filter((file) => file.endsWith('/+server.ts'))) {
			expect(text(path), path).toMatch(/export const POST: RequestHandler = route\.public\(/);
			expect(text(path), path).not.toMatch(/export const (GET|PUT|PATCH|DELETE)/);
		}
	});
});

describe('machine pages answer 404 to members who cannot see the machine (SPEC-ACCESS A6)', () => {
	async function setUp() {
		const admin = toConsoleUser(
			await addTestUser(appDatabase, {
				email: `admin-${crypto.randomUUID()}@example.com`,
				role: 'admin',
				password: null
			})
		);
		const member = toConsoleUser(
			await addTestUser(appDatabase, {
				email: `member-${crypto.randomUUID()}@example.com`,
				role: 'member',
				password: null
			})
		);
		const seen = enrolFakeAgent(appDatabase, NOW).machineId;
		const hidden = enrolFakeAgent(appDatabase, NOW).machineId;
		grantAccess(appDatabase, {
			adminId: admin.id,
			name: `IT ${crypto.randomUUID()}`,
			memberIds: [member.id],
			machineIds: [seen],
			permissions: ['view', 'terminal'],
			consent: 'unattended'
		});
		return { admin, member, seen, hidden };
	}

	function machineEvent(user: ConsoleUser, id: string): Parameters<typeof machineLayout>[0] {
		const partial = {
			...event({ kind: 'signed-in', user }, `/machines/${id}`),
			params: { id }
		};
		return partial as Parameters<typeof machineLayout>[0];
	}

	it('A6: the machine pages load for a member with view and for admins, and 404 otherwise', async () => {
		const { admin, member, seen, hidden } = await setUp();
		const loaded = await machineLayout(machineEvent(member, seen));
		expect(loaded).toMatchObject({
			machine: { id: seen },
			grants: [
				{ permission: 'view', consent: 'unattended' },
				{ permission: 'terminal', consent: 'unattended' }
			]
		});
		expect(await machineLayout(machineEvent(admin, hidden))).toMatchObject({
			machine: { id: hidden }
		});
		const refused = await Promise.resolve()
			.then(() => machineLayout(machineEvent(member, hidden)))
			.catch((error: unknown) => error);
		expect(isHttpError(refused, 404)).toBe(true);
	});

	it('A6: the notes API answers 404 for a machine the member cannot see', async () => {
		const { member, seen, hidden } = await setUp();
		const request = (id: string) => {
			const partial = {
				...event({ kind: 'signed-in', user: member }, `/api/machines/${id}/notes`),
				params: { id }
			};
			return partial as Parameters<typeof notesGet>[0];
		};
		expect((await notesGet(request(seen))).status).toBe(200);
		const refused = await Promise.resolve()
			.then(() => notesGet(request(hidden)))
			.catch((error: unknown) => error);
		expect(isHttpError(refused, 404)).toBe(true);
	});
});
