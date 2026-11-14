import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { UserView } from '#lib/domain/users/user.ts';
import { confirmation } from '#lib/ui/confirm-action.svelte.ts';
import UsersPage from './+page.svelte';

vi.mock('$app/navigation', () => ({ refreshAll: vi.fn(() => Promise.resolve()) }));

const NOW = Date.parse('2026-11-14T10:00:00Z');
const ME = '11111111-1111-4111-8111-111111111111';
const BEA = '22222222-2222-4222-8222-222222222222';

function person(id: string, name: string): UserView {
	return {
		id,
		name,
		email: `${name.toLowerCase()}@example.com`,
		role: 'admin',
		status: { kind: 'active' },
		hasPassword: true,
		providerNames: [],
		lastSignIn: { kind: 'at', iso: '2026-11-13T08:00:00.000Z' },
		createdIso: '2026-11-01T00:00:00.000Z'
	};
}

let calls: { method: string; url: string }[] = [];

beforeEach(() => {
	calls = [];
	if (confirmation.current.kind === 'asking') confirmation.current.answer({ kind: 'no' });
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			calls.push({ method: init.method ?? 'GET', url });
			return Promise.resolve(Response.json({ reset: true }));
		})
	);
});

function show() {
	return render(UsersPage, {
		params: {},
		form: undefined,
		data: {
			user: { id: ME, name: 'Ada', email: 'ada@example.com', role: 'admin' },
			localNetworkMode: false,
			serverUpdate: null,
			runCommands: false,
			assistant: { kind: 'none' },
			approvals: { kind: 'hidden' },
			signedIn: true,
			now: NOW,
			me: ME,
			users: [person(ME, 'Ada'), person(BEA, 'Bea')],
			userGroups: [],
			emailReady: false,
			twoFactorOn: { [ME]: '2026-11-10T10:00:00.000Z', [BEA]: '2026-11-12T10:00:00.000Z' }
		}
	});
}

describe('two-factor on the Users page (SPEC-TWO-FACTOR TF14)', () => {
	it('shows who has it on, and resets another person’s after a confirmation', async () => {
		const screen = await show();
		expect(screen.getByText('Two-factor', { exact: true }).elements()).toHaveLength(2);
		await screen.getByRole('button', { name: /^B Bea/ }).click();
		await expect.element(screen.getByText(/On, turned on/)).toBeVisible();
		await screen.getByRole('button', { name: 'Reset two-factor' }).click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		expect(calls).toEqual([]);
		if (confirmation.current.kind === 'asking') {
			confirmation.current.answer({ kind: 'yes', recheck: { kind: 'none' } });
		}
		await expect
			.poll(() => calls)
			.toEqual([{ method: 'DELETE', url: `/api/users/${BEA}/two-factor` }]);
	});

	it('offers no reset for the admin’s own (they turn it off on Account)', async () => {
		const screen = await show();
		await screen.getByRole('button', { name: /^A Ada/ }).click();
		await expect.element(screen.getByText(/On, turned on/)).toBeVisible();
		expect(screen.getByRole('button', { name: 'Reset two-factor' }).elements()).toHaveLength(0);
	});
});
