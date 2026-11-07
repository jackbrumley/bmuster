import { describe, expect, it } from 'vitest';
import { SETTING_DEFINITIONS, SETTING_KEYS } from '#lib/domain/settings/settings-definitions.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { listAudit } from '../audit/audit.ts';
import { getSetting, listSettings, updateSetting } from './settings.ts';

describe('server settings (S16)', () => {
	it('declares each setting once, with a default its own type accepts, changed by admins', () => {
		expect(SETTING_KEYS).toEqual([
			'defaultConsent',
			'connectedNotice',
			'agentUpdatePolicy',
			'maxUploadGb',
			'localNetworkMode'
		]);
		for (const key of SETTING_KEYS) {
			const definition = SETTING_DEFINITIONS[key];
			expect(definition.schema.safeParse(definition.defaultValue).success, key).toBe(true);
			expect(definition.changedBy).toBe('admin');
		}
	});

	it('starts with new rules unattended, the notice on and local network mode off (L1)', () => {
		const database = testDatabase();
		expect(getSetting(database, 'defaultConsent')).toBe('unattended');
		expect(getSetting(database, 'connectedNotice')).toBe(true);
		expect(getSetting(database, 'localNetworkMode')).toBe(false);
		expect(SETTING_DEFINITIONS.localNetworkMode).toMatchObject({
			label: 'Local network mode',
			section: 'security',
			control: { kind: 'local-network-mode' }
		});
		expect(listSettings(database).every((setting) => setting.isDefault)).toBe(true);
	});

	it('changes a setting, audits it, and refuses a value of the wrong type', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'a@example.com',
			role: 'admin',
			password: null
		});
		expect(updateSetting(database, admin.id, 'connectedNotice', false, NOW).kind).toBe('changed');
		expect(getSetting(database, 'connectedNotice')).toBe(false);
		expect(updateSetting(database, admin.id, 'defaultConsent', 'ask', NOW).kind).toBe('changed');
		expect(getSetting(database, 'defaultConsent')).toBe('ask');
		expect(updateSetting(database, admin.id, 'defaultConsent', 'sometimes', NOW).kind).toBe(
			'invalid'
		);
		expect(updateSetting(database, admin.id, 'connectedNotice', 'off', NOW).kind).toBe('invalid');
		expect(listAudit(database, 10)).toEqual([
			expect.objectContaining({
				kind: 'setting-changed',
				target: 'Default for new access rules',
				detail: { from: 'unattended', to: 'ask' }
			}),
			expect.objectContaining({
				kind: 'setting-changed',
				target: 'Show a notice while connected',
				detail: { from: 'true', to: 'false' }
			})
		]);
	});
});
