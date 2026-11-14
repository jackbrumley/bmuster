import { describe, expect, it } from 'vitest';
import { twoFactorRequired } from '#lib/domain/auth/two-factor.ts';
import { SETTING_DEFINITIONS } from '#lib/domain/settings/settings-definitions.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { NOW } from '#tests/helpers/people.ts';
import { getSetting, updateSetting } from '../settings/settings.ts';
import { listAudit } from '../audit/audit.ts';

describe('the Two-factor sign-in setting (SPEC-TWO-FACTOR TF1)', () => {
	it('offers Off, Required for admins and Required for everyone, under Security', () => {
		expect(SETTING_DEFINITIONS.twoFactorSignIn).toMatchObject({
			label: 'Two-factor sign-in',
			section: 'security',
			defaultValue: 'off',
			control: {
				kind: 'choice',
				options: [
					{ value: 'off', label: 'Off' },
					{ value: 'admins', label: 'Required for admins' },
					{ value: 'everyone', label: 'Required for everyone' }
				]
			}
		});
	});

	it('is Off on a server that has never stored it, so updating locks nobody out', () => {
		expect(getSetting(testDatabase(), 'twoFactorSignIn')).toBe('off');
	});

	it('requires it by role as the value says', () => {
		expect(twoFactorRequired('off', 'admin')).toBe(false);
		expect(twoFactorRequired('admins', 'admin')).toBe(true);
		expect(twoFactorRequired('admins', 'member')).toBe(false);
		expect(twoFactorRequired('everyone', 'member')).toBe(true);
	});

	it('audits a change like every setting', () => {
		const database = testDatabase();
		const result = updateSetting(database, 'admin-id', 'twoFactorSignIn', 'everyone', NOW);
		expect(result.kind).toBe('changed');
		expect(listAudit(database, 1)[0]).toMatchObject({
			kind: 'setting-changed',
			target: 'Two-factor sign-in',
			detail: { from: 'off', to: 'everyone' }
		});
		expect(updateSetting(database, 'admin-id', 'twoFactorSignIn', 'sometimes', NOW).kind).toBe(
			'invalid'
		);
	});
});
