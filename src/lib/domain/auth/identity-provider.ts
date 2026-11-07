/** OpenID Connect providers people sign in with. Browser-safe. */

export type ProviderKind = 'microsoft-entra' | 'authentik' | 'generic-oidc';

export const PROVIDER_KINDS: readonly ProviderKind[] = [
	'microsoft-entra',
	'authentik',
	'generic-oidc'
];

/** What happens when someone the provider accepts has no BMuster account yet. */
export type NewPeopleMode = 'invited' | 'auto-create';

export const NEW_PEOPLE_MODES: readonly NewPeopleMode[] = ['invited', 'auto-create'];

export function newPeopleLabel(mode: NewPeopleMode): string {
	switch (mode) {
		case 'invited':
			return 'Invited only';
		case 'auto-create':
			return 'Anyone the provider accepts (no access until an admin gives it)';
	}
}

/** A provider as the admin pages see it. The client secret never leaves the server. */
export type IdentityProviderView = {
	id: string;
	name: string;
	kind: ProviderKind;
	issuer: string;
	clientId: string;
	hasClientSecret: boolean;
	scopes: string[];
	newPeople: NewPeopleMode;
	enabled: boolean;
	createdIso: string;
};

/** A "Continue with …" button on the sign-in page. */
export type SignInProvider = { id: string; name: string; kind: ProviderKind };

/** Preset forms: the name and issuer pattern each kind starts with. */
export type ProviderPreset = {
	label: string;
	name: string;
	issuerPlaceholder: string;
	issuerHelp: string;
};

export function providerPreset(kind: ProviderKind): ProviderPreset {
	switch (kind) {
		case 'microsoft-entra':
			return {
				label: 'Microsoft 365',
				name: 'Microsoft 365',
				issuerPlaceholder: 'https://login.microsoftonline.com/<tenant id>/v2.0',
				issuerHelp: 'Entra admin centre → App registrations → your app → Directory (tenant) ID.'
			};
		case 'authentik':
			return {
				label: 'Authentik',
				name: 'Authentik',
				issuerPlaceholder: 'https://auth.example.com/application/o/bmuster/',
				issuerHelp:
					'Authentik → Applications → Providers → your provider → OpenID Configuration Issuer.'
			};
		case 'generic-oidc':
			return {
				label: 'Other OpenID Connect',
				name: '',
				issuerPlaceholder: 'https://id.example.com',
				issuerHelp: 'The issuer URL; /.well-known/openid-configuration must be under it.'
			};
	}
}

export const DEFAULT_SCOPES: readonly string[] = ['openid', 'email', 'profile'];
