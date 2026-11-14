import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { database } from '#lib/server/database/app-database.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { enrolFakeAgent } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { load } from './+page.server.ts';

const DAY = 24 * 60 * 60 * 1000;

async function person(role: 'admin' | 'member'): Promise<ConsoleUser> {
	return toConsoleUser(
		await addTestUser(database, {
			email: `donate-${crypto.randomUUID()}@example.com`,
			role,
			password: null
		})
	);
}

/** The Machines page's data for `user` on day `day` after the first account was made. */
async function donateOn(user: ConsoleUser, day: number): Promise<unknown> {
	vi.setSystemTime(NOW + day * DAY);
	const url = new URL('https://bmuster.test/');
	const partial: Pick<RequestEvent, 'locals' | 'url' | 'request'> = {
		locals: { session: { kind: 'signed-in', user } },
		url,
		request: new Request(url)
	};
	const data = await load(partial as Parameters<typeof load>[0]);
	if (data === undefined) throw new Error('The Machines page loaded nothing.');
	return data['donate'];
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
	vi.useRealTimers();
});

describe('donate reminder on the Machines page (SPEC-DONATE)', () => {
	it('D1, D2: shows only to admins, after 14 days in use and once a machine is enrolled', async () => {
		const admin = await person('admin');
		const member = await person('member');
		expect(await donateOn(admin, 20)).toEqual({ kind: 'hidden' });
		enrolFakeAgent(database, NOW);
		expect(await donateOn(admin, 13)).toEqual({ kind: 'hidden' });
		expect(await donateOn(admin, 14)).toEqual({ kind: 'shown', wording: 'first' });
		expect(await donateOn(member, 400)).toEqual({ kind: 'hidden' });
	});
});

function sourceFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? sourceFiles(path) : [path];
	});
}

describe('where the reminder can appear (SPEC-DONATE D7)', () => {
	it('D7: only the Machines page renders it', () => {
		const importers = sourceFiles('src')
			.filter((path) => /\.(svelte|ts)$/.test(path) && !path.endsWith('.test.ts'))
			.filter((path) => readFileSync(path, 'utf8').includes('donate-reminder.svelte'));
		expect(importers).toEqual([join('src', 'routes', '(console)', '+page.svelte')]);
	});
});
