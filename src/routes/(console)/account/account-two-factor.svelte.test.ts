import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import type { TwoFactorStatus } from '#lib/domain/auth/two-factor.ts';
import { confirmation } from '#lib/ui/confirm-action.svelte.ts';
import TwoFactorPanel from './two-factor-panel.svelte';

vi.mock('$app/navigation', () => ({ refreshAll: vi.fn(() => Promise.resolve()) }));

const NOW = Date.parse('2026-11-14T10:00:00Z');
const CODES = Array.from({ length: 10 }, (_, index) => `ABCD-EFGH-JKLM-NP${String(index + 20)}`);
const KEY = {
	otpauthUri: 'otpauth://totp/BMuster:ada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=BMuster',
	keyText: 'JBSW Y3DP EHPK 3PXP',
	qr: { size: 29, path: 'M4 4h7v1h-7z' }
};

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];

beforeEach(() => {
	calls = [];
	if (confirmation.current.kind === 'asking') confirmation.current.answer({ kind: 'no' });
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string, init: RequestInit) => {
			const method = init.method ?? 'GET';
			calls.push({
				method,
				url,
				body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined
			});
			if (url.endsWith('/set-up')) return Promise.resolve(Response.json({ key: KEY }));
			if (method === 'DELETE') return Promise.resolve(Response.json({ turnedOff: true }));
			return Promise.resolve(Response.json({ recoveryCodes: CODES }));
		})
	);
});

function show(status: TwoFactorStatus) {
	return render(TwoFactorPanel, {
		status,
		email: 'ada@example.com',
		origin: 'https://bmuster.example.com',
		now: NOW
	});
}

describe('two-factor sign-in on the Account page (SPEC-TWO-FACTOR TF17)', () => {
	it('sets it up: QR code and key, first code and password, then the recovery codes once', async () => {
		const screen = await show({ kind: 'off', required: true });
		await expect
			.element(screen.getByText('This server requires two-factor sign-in for you'))
			.toBeVisible();
		await screen.getByRole('button', { name: 'Set up' }).click();
		await expect
			.element(screen.getByRole('img', { name: 'QR code for your authenticator app' }))
			.toBeVisible();
		await expect.element(screen.getByText('JBSW Y3DP EHPK 3PXP')).toBeVisible();
		await screen.getByLabelText('Code from your authenticator app').fill('123 456');
		await screen.getByLabelText('Your password').fill('correct horse battery');
		await screen.getByRole('button', { name: 'Turn on' }).click();
		await expect.element(screen.getByText('Save these recovery codes now')).toBeVisible();
		await expect.element(screen.getByText(CODES[0] ?? '')).toBeVisible();
		expect(calls).toEqual([
			{ method: 'POST', url: '/api/account/two-factor/set-up', body: {} },
			{
				method: 'POST',
				url: '/api/account/two-factor',
				body: { code: '123 456', password: 'correct horse battery' }
			}
		]);
	});

	it('checks the code’s shape before sending anything', async () => {
		const screen = await show({ kind: 'off', required: false });
		await screen.getByRole('button', { name: 'Set up' }).click();
		await screen.getByLabelText('Code from your authenticator app').fill('12');
		await screen.getByLabelText('Your password').fill('correct horse battery');
		await screen.getByRole('button', { name: 'Turn on' }).click();
		await expect
			.element(screen.getByText('Type the 6-digit code from your authenticator app.'))
			.toBeVisible();
		expect(calls.map((call) => call.url)).toEqual(['/api/account/two-factor/set-up']);
	});

	it('shows how many recovery codes are left, warns when few, and makes new ones', async () => {
		const screen = await show({
			kind: 'on',
			sinceIso: '2026-11-10T10:00:00Z',
			recoveryCodesLeft: 2,
			required: false
		});
		await expect.element(screen.getByText(/2 of 10 recovery codes left/)).toBeVisible();
		await expect.element(screen.getByText('Few recovery codes left')).toBeVisible();
		await screen.getByRole('button', { name: 'New recovery codes' }).click();
		await screen.getByLabelText('Code from your authenticator app').fill('654321');
		await screen.getByRole('button', { name: 'Make new codes' }).click();
		await expect.element(screen.getByText(CODES[3] ?? '')).toBeVisible();
		expect(calls).toEqual([
			{
				method: 'POST',
				url: '/api/account/two-factor/recovery-codes',
				body: { code: '654321' }
			}
		]);
	});

	it('turns it off with the password and a code, after a confirmation', async () => {
		const screen = await show({
			kind: 'on',
			sinceIso: '2026-11-10T10:00:00Z',
			recoveryCodesLeft: 10,
			required: false
		});
		await screen.getByRole('button', { name: 'Turn off' }).click();
		await screen.getByLabelText('Your password').fill('correct horse battery');
		await screen
			.getByLabelText('Code from your authenticator app, or a recovery code')
			.fill('ABCD-EFGH-JKLM-NP20');
		await screen.getByRole('button', { name: 'Turn off' }).last().click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		expect(calls).toEqual([]);
		if (confirmation.current.kind === 'asking') {
			confirmation.current.answer({ kind: 'yes', recheck: { kind: 'none' } });
		}
		await expect
			.poll(() => calls)
			.toEqual([
				{
					method: 'DELETE',
					url: '/api/account/two-factor',
					body: { password: 'correct horse battery', code: 'ABCD-EFGH-JKLM-NP20' }
				}
			]);
	});

	it('offers no Turn off while the server requires it, and nothing for provider-only people', async () => {
		const required = await show({
			kind: 'on',
			sinceIso: '2026-11-10T10:00:00Z',
			recoveryCodesLeft: 10,
			required: true
		});
		await expect
			.element(required.getByText('This server requires it for you, so it cannot be turned off.'))
			.toBeVisible();
		expect(required.getByRole('button', { name: 'Turn off' }).elements()).toHaveLength(0);
		await required.unmount();

		const provider = await show({ kind: 'no-password', providerNames: ['Microsoft 365'] });
		await expect.element(provider.getByText(/You sign in through Microsoft 365/)).toBeVisible();
		expect(provider.getByRole('button').elements()).toHaveLength(0);
	});
});
