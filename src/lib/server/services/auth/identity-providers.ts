import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type {
	IdentityProviderView,
	NewPeopleMode,
	ProviderKind,
	SignInProvider
} from '#lib/domain/auth/identity-provider.ts';
import { identityProviders } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { openSecret, sealSecret } from '../../crypto/secret-box.ts';
import { recordAudit } from '../audit/audit.ts';

/**
 * OpenID Connect providers (SPEC-SIGN-IN S9). The client secret is sealed
 * with SECRETS_KEY (AES-256-GCM) and is write-only: views say only whether
 * one is set. Only the sign-in flow opens it.
 */
type ProviderRow = typeof identityProviders.$inferSelect;

export type ProviderFields = {
	name: string;
	kind: ProviderKind;
	issuer: string;
	clientId: string;
	scopes: string[];
	newPeople: NewPeopleMode;
	enabled: boolean;
};

/** A provider with its secret opened, for the sign-in flow only. */
export type ProviderForSignIn = ProviderFields & { id: string; clientSecret: string };

const scopesSchema = z.array(z.string());

function parseScopes(row: ProviderRow): string[] {
	return scopesSchema.parse(JSON.parse(row.scopes));
}

function toView(row: ProviderRow): IdentityProviderView {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		issuer: row.issuer,
		clientId: row.clientId,
		hasClientSecret: row.clientSecretSealed !== '',
		scopes: parseScopes(row),
		newPeople: row.newPeople,
		enabled: row.enabled,
		createdIso: row.createdAt.toISOString()
	};
}

export function listProviders(database: Queryable): IdentityProviderView[] {
	return database
		.select()
		.from(identityProviders)
		.orderBy(asc(identityProviders.name))
		.all()
		.map(toView);
}

/** The "Continue with …" buttons: enabled providers only. */
export function signInProviders(database: Queryable): SignInProvider[] {
	return database
		.select({
			id: identityProviders.id,
			name: identityProviders.name,
			kind: identityProviders.kind
		})
		.from(identityProviders)
		.where(eq(identityProviders.enabled, true))
		.orderBy(asc(identityProviders.name))
		.all();
}

export function providerForSignIn(
	database: Queryable,
	id: string,
	secretsKey: Buffer
): ProviderForSignIn | undefined {
	const row = database.select().from(identityProviders).where(eq(identityProviders.id, id)).get();
	if (row === undefined) {
		return undefined;
	}
	return {
		id: row.id,
		name: row.name,
		kind: row.kind,
		issuer: row.issuer,
		clientId: row.clientId,
		clientSecret: openSecret(row.clientSecretSealed, secretsKey).toString('utf8'),
		scopes: parseScopes(row),
		newPeople: row.newPeople,
		enabled: row.enabled
	};
}

/** What the audit entry says about a provider; never the secret. */
function auditDetail(fields: ProviderFields): Record<string, string> {
	return {
		kind: fields.kind,
		issuer: fields.issuer,
		clientId: fields.clientId,
		newPeople: fields.newPeople,
		enabled: fields.enabled ? 'on' : 'off'
	};
}

export function addProvider(
	database: AppDatabase,
	actorUserId: string,
	fields: ProviderFields & { clientSecret: string },
	secretsKey: Buffer,
	now: number
): IdentityProviderView {
	return database.transaction((transaction) => {
		const row: ProviderRow = {
			id: crypto.randomUUID(),
			name: fields.name,
			kind: fields.kind,
			issuer: fields.issuer,
			clientId: fields.clientId,
			clientSecretSealed: sealSecret(Buffer.from(fields.clientSecret, 'utf8'), secretsKey),
			scopes: JSON.stringify(fields.scopes),
			newPeople: fields.newPeople,
			enabled: fields.enabled,
			createdAt: new Date(now)
		};
		transaction.insert(identityProviders).values(row).run();
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'provider-added',
				target: row.name,
				detail: auditDetail(fields)
			},
			now
		);
		return toView(row);
	});
}

export type SecretChange = { kind: 'keep' } | { kind: 'replace'; value: string };

export function updateProvider(
	database: AppDatabase,
	actorUserId: string,
	id: string,
	fields: ProviderFields & { clientSecret: SecretChange },
	secretsKey: Buffer,
	now: number
): IdentityProviderView | undefined {
	return database.transaction((transaction) => {
		const existing = transaction
			.select()
			.from(identityProviders)
			.where(eq(identityProviders.id, id))
			.get();
		if (existing === undefined) {
			return undefined;
		}
		const secret =
			fields.clientSecret.kind === 'replace'
				? sealSecret(Buffer.from(fields.clientSecret.value, 'utf8'), secretsKey)
				: existing.clientSecretSealed;
		transaction
			.update(identityProviders)
			.set({
				name: fields.name,
				kind: fields.kind,
				issuer: fields.issuer,
				clientId: fields.clientId,
				clientSecretSealed: secret,
				scopes: JSON.stringify(fields.scopes),
				newPeople: fields.newPeople,
				enabled: fields.enabled
			})
			.where(eq(identityProviders.id, id))
			.run();
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'provider-changed',
				target: fields.name,
				detail: {
					...auditDetail(fields),
					clientSecret: fields.clientSecret.kind === 'replace' ? 'replaced' : 'kept'
				}
			},
			now
		);
		const updated = transaction
			.select()
			.from(identityProviders)
			.where(eq(identityProviders.id, id))
			.get();
		return updated === undefined ? undefined : toView(updated);
	});
}

/** Deletes a provider and the account links made through it (people keep their accounts). */
export function deleteProvider(
	database: AppDatabase,
	actorUserId: string,
	id: string,
	now: number
): boolean {
	return database.transaction((transaction) => {
		const existing = transaction
			.select()
			.from(identityProviders)
			.where(eq(identityProviders.id, id))
			.get();
		if (existing === undefined) {
			return false;
		}
		transaction.delete(identityProviders).where(eq(identityProviders.id, id)).run();
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'provider-deleted',
				target: existing.name,
				detail: { kind: existing.kind, issuer: existing.issuer }
			},
			now
		);
		return true;
	});
}
