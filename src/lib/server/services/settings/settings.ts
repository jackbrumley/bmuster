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
import { recordAudit, type AuditActor } from '../audit/audit.ts';

/**
 * Server settings (SPEC-SIGN-IN S16). Each is declared in
 * settings-definitions.ts; a setting without a row has its default. Stored
 * values are checked against the declared type on every read, so a bad row
 * fails loudly instead of acting as some other value.
 */
/** Each setting's declared type, keyed so the compiler ties every key to its value type. */
const PARSE: { [K in SettingKey]: (value: unknown) => SettingValues[K] } = {
	serverUpdateChecks: (value) => SETTING_DEFINITIONS.serverUpdateChecks.schema.parse(value),
	defaultConsent: (value) => SETTING_DEFINITIONS.defaultConsent.schema.parse(value),
	connectedNotice: (value) => SETTING_DEFINITIONS.connectedNotice.schema.parse(value),
	agentUpdatePolicy: (value) => SETTING_DEFINITIONS.agentUpdatePolicy.schema.parse(value),
	maxUploadGb: (value) => SETTING_DEFINITIONS.maxUploadGb.schema.parse(value),
	localNetworkMode: (value) => SETTING_DEFINITIONS.localNetworkMode.schema.parse(value),
	organisationName: (value) => SETTING_DEFINITIONS.organisationName.schema.parse(value),
	scamImpersonators: (value) => SETTING_DEFINITIONS.scamImpersonators.schema.parse(value),
	scamReportAdvice: (value) => SETTING_DEFINITIONS.scamReportAdvice.schema.parse(value)
};

const DEFAULTS: SettingValues = {
	serverUpdateChecks: SETTING_DEFINITIONS.serverUpdateChecks.defaultValue,
	defaultConsent: SETTING_DEFINITIONS.defaultConsent.defaultValue,
	connectedNotice: SETTING_DEFINITIONS.connectedNotice.defaultValue,
	agentUpdatePolicy: SETTING_DEFINITIONS.agentUpdatePolicy.defaultValue,
	maxUploadGb: SETTING_DEFINITIONS.maxUploadGb.defaultValue,
	localNetworkMode: SETTING_DEFINITIONS.localNetworkMode.defaultValue,
	organisationName: SETTING_DEFINITIONS.organisationName.defaultValue,
	scamImpersonators: SETTING_DEFINITIONS.scamImpersonators.defaultValue,
	scamReportAdvice: SETTING_DEFINITIONS.scamReportAdvice.defaultValue
};

export function getSetting<K extends SettingKey>(database: Queryable, key: K): SettingValues[K] {
	const row = database.select().from(settings).where(eq(settings.key, key)).get();
	return row === undefined ? DEFAULTS[key] : PARSE[key](JSON.parse(row.value));
}

/**
 * The organisation callers are told about on /join (SPEC-JOIN J11): the
 * setting, or this server's host name as people reach it when it is blank.
 */
export function organisationName(database: Queryable, hostname: string): string {
	const name = getSetting(database, 'organisationName');
	return name === '' ? hostname : name;
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
		const issue = parsed.error.issues[0];
		return {
			kind: 'invalid',
			message:
				definition.control.kind === 'text' && issue !== undefined
					? `“${definition.label}”: ${issue.message}`
					: `That is not a valid value for “${definition.label}”.`
		};
	}
	writeSetting(database, { kind: 'user', userId: actorUserId }, key, parsed.data, {}, now);
	return { kind: 'changed', settings: listSettings(database) };
}

/**
 * Changes one setting on the server's own behalf (start-up, from the
 * installer's environment), and audits it with the system as the actor and
 * `source` naming where the value came from.
 */
export function updateSettingAsSystem<K extends SettingKey>(
	database: AppDatabase,
	key: K,
	value: SettingValues[K],
	source: string,
	now: number
): void {
	writeSetting(database, { kind: 'system' }, key, value, { source }, now);
}

function writeSetting(
	database: AppDatabase,
	actor: AuditActor,
	key: SettingKey,
	value: unknown,
	extraDetail: Record<string, string>,
	now: number
): void {
	const definition = SETTING_DEFINITIONS[key];
	const updatedBy = actor.kind === 'user' ? actor.userId : 'system';
	database.transaction((transaction) => {
		const before = getSetting(transaction, key);
		transaction
			.insert(settings)
			.values({ key, value: JSON.stringify(value), updatedAt: new Date(now), updatedBy })
			.onConflictDoUpdate({
				target: settings.key,
				set: { value: JSON.stringify(value), updatedAt: new Date(now), updatedBy }
			})
			.run();
		recordAudit(
			transaction,
			{
				actor,
				kind: 'setting-changed',
				target: definition.label,
				machineId: null,
				detail: { from: String(before), to: String(value), ...extraDetail }
			},
			now
		);
	});
}
