import { describe, expect, it } from 'vitest';
import {
	createProviderRequestSchema,
	updateProviderRequestSchema
} from '#lib/schemas/auth/identity-providers.ts';
import { providerPreset } from '#lib/domain/auth/identity-provider.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { identityProviders } from '../../database/schema.ts';
import { listAudit } from '../audit/audit.ts';
import {
	addProvider,
	deleteProvider,
	listProviders,
	providerForSignIn,
	signInProviders,
	updateProvider
} from './identity-providers.ts';

const KEY = Buffer.alloc(32, 3);
const SECRET = 'super-secret-client-value';

const ENTRA = {
	name: 'Microsoft 365',
	kind: 'microsoft-entra' as const,
	issuer: 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000000/v2.0',
	clientId: 'bmuster-client',
	clientSecret: SECRET,
	scopes: ['openid', 'email', 'profile'],
	newPeople: 'invited' as const,
	enabled: true
};

describe('identity providers (S9)', () => {
	it('has presets for Microsoft 365 and Authentik, and a generic form', () => {
		expect(providerPreset('microsoft-entra').issuerPlaceholder).toContain(
			'login.microsoftonline.com'
		);
		expect(providerPreset('authentik').issuerPlaceholder).toContain('/application/o/');
		expect(providerPreset('generic-oidc').name).toBe('');
	});

	it('takes issuer, client id, secret and new-people mode, checked by the shared schema', () => {
		expect(createProviderRequestSchema.safeParse(ENTRA).success).toBe(true);
		expect(
			createProviderRequestSchema.safeParse({ ...ENTRA, issuer: 'http://insecure.example' }).success
		).toBe(false);
		expect(createProviderRequestSchema.safeParse({ ...ENTRA, scopes: ['email'] }).success).toBe(
			false
		);
		expect(createProviderRequestSchema.safeParse({ ...ENTRA, newPeople: 'everyone' }).success).toBe(
			false
		);
		expect(
			updateProviderRequestSchema.safeParse({ ...ENTRA, clientSecret: { kind: 'keep' } }).success
		).toBe(true);
	});

	it('encrypts the client secret and never shows it', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'a@example.com',
			role: 'admin',
			password: null
		});
		const view = addProvider(database, admin.id, ENTRA, KEY, NOW);
		expect(view).toMatchObject({
			name: 'Microsoft 365',
			hasClientSecret: true,
			newPeople: 'invited'
		});
		expect(JSON.stringify(view)).not.toContain(SECRET);
		expect(JSON.stringify(listProviders(database))).not.toContain(SECRET);
		expect(JSON.stringify(database.select().from(identityProviders).all())).not.toContain(SECRET);
		expect(JSON.stringify(listAudit(database, 10))).not.toContain(SECRET);
		expect(providerForSignIn(database, view.id, KEY)?.clientSecret).toBe(SECRET);
		expect(() => providerForSignIn(database, view.id, Buffer.alloc(32, 4))).toThrow();
	});

	it('keeps the secret on edit unless a new one is sent', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'a@example.com',
			role: 'admin',
			password: null
		});
		const { id } = addProvider(database, admin.id, ENTRA, KEY, NOW);
		updateProvider(
			database,
			admin.id,
			id,
			{ ...ENTRA, name: 'Office', clientSecret: { kind: 'keep' } },
			KEY,
			NOW
		);
		expect(providerForSignIn(database, id, KEY)).toMatchObject({
			name: 'Office',
			clientSecret: SECRET
		});
		updateProvider(
			database,
			admin.id,
			id,
			{ ...ENTRA, newPeople: 'auto-create', clientSecret: { kind: 'replace', value: 'rotated' } },
			KEY,
			NOW
		);
		expect(providerForSignIn(database, id, KEY)).toMatchObject({
			clientSecret: 'rotated',
			newPeople: 'auto-create'
		});
	});

	it('shows only enabled providers on the sign-in page, and can be deleted', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'a@example.com',
			role: 'admin',
			password: null
		});
		const on = addProvider(database, admin.id, ENTRA, KEY, NOW);
		addProvider(
			database,
			admin.id,
			{ ...ENTRA, name: 'Authentik', kind: 'authentik', enabled: false },
			KEY,
			NOW
		);
		expect(signInProviders(database)).toEqual([
			{ id: on.id, name: 'Microsoft 365', kind: 'microsoft-entra' }
		]);
		expect(deleteProvider(database, admin.id, on.id, NOW)).toBe(true);
		expect(deleteProvider(database, admin.id, on.id, NOW)).toBe(false);
		expect(listProviders(database).map((provider) => provider.name)).toEqual(['Authentik']);
	});
});
