import { eq } from 'drizzle-orm';
import {
	SETTING_DEFINITIONS,
	SETTING_KEYS,
	type SettingKey,
	type SettingValues,
	type SettingView
} from '#lib/domain/settings/settings-definitions.ts';
import { settings } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';

/**
 * Server settings (SPEC-SIGN-IN S16). Each is declared in
 * settings-definitions.ts; a setting without a row has its default. Stored
 * values are checked against the declared type on every read, so a bad row
 * fails loudly instead of acting as some other value.
 */
/** Each setting's declared type, keyed so the compiler ties every key to its value type. */
const PARSE: { [K in SettingKey]: (value: unknown) => SettingValues[K] } = {
	defaultConsent: (value) => SETTING_DEFINITIONS.defaultConsent.schema.parse(value),
	connectedNotice: (value) => SETTING_DEFINITIONS.connectedNotice.schema.parse(value)
};

const DEFAULTS: SettingValues = {
	defaultConsent: SETTING_DEFINITIONS.defaultConsent.defaultValue,
	connectedNotice: SETTING_DEFINITIONS.connectedNotice.defaultValue
};

export function getSetting<K extends SettingKey>(database: Queryable, key: K): SettingValues[K] {
	const row = database.select().from(settings).where(eq(settings.key, key)).get();
	return row === undefined ? DEFAULTS[key] : PARSE[key](JSON.parse(row.value));
}

export function listSettings(database: Queryable): SettingView[] {
	const rows = new Map(
		database
			.select()
			.from(settings)
			.all()
			.map((row) => [row.key, row])
	);
	return SETTING_KEYS.map((key) => {
		const row = rows.get(key);
		const value = getSetting(database, key);
		return {
			key,
			value,
			isDefault: value === SETTING_DEFINITIONS[key].defaultValue,
			updated:
				row === undefined ? { kind: 'never' } : { kind: 'at', iso: row.updatedAt.toISOString() }
		};
	});
}

export type SettingChange =
	{ kind: 'changed'; settings: SettingView[] } | { kind: 'invalid'; message: string };

/** Changes one setting for an admin, and audits it. */
export function updateSetting(
	database: AppDatabase,
	actorUserId: string,
	key: SettingKey,
	value: unknown,
	now: number
): SettingChange {
	const definition = SETTING_DEFINITIONS[key];
	const parsed = definition.schema.safeParse(value);
	if (!parsed.success) {
		return { kind: 'invalid', message: `That is not a valid value for “${definition.label}”.` };
	}
	database.transaction((transaction) => {
		const before = getSetting(transaction, key);
		transaction
			.insert(settings)
			.values({
				key,
				value: JSON.stringify(parsed.data),
				updatedAt: new Date(now),
				updatedBy: actorUserId
			})
			.onConflictDoUpdate({
				target: settings.key,
				set: {
					value: JSON.stringify(parsed.data),
					updatedAt: new Date(now),
					updatedBy: actorUserId
				}
			})
			.run();
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'setting-changed',
				target: definition.label,
				detail: { from: String(before), to: String(parsed.data) }
			},
			now
		);
	});
	return { kind: 'changed', settings: listSettings(database) };
}
