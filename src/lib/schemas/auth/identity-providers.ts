import { z } from 'zod';
import { NEW_PEOPLE_MODES, PROVIDER_KINDS } from '#lib/domain/auth/identity-provider.ts';

const scopeSchema = z.string().regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/, 'Scopes are single words.');

const providerFields = {
	name: z.string().trim().min(1, 'Enter a name.').max(60),
	kind: z.enum(PROVIDER_KINDS),
	issuer: z
		.url({ protocol: /^https$/, error: 'Enter the issuer URL (https://…).' })
		.max(500)
		.transform((issuer) => issuer.trim()),
	clientId: z.string().trim().min(1, 'Enter the client id.').max(500),
	scopes: z
		.array(scopeSchema)
		.min(1)
		.max(20)
		.refine((scopes) => scopes.includes('openid'), 'The scopes must include openid.'),
	newPeople: z.enum(NEW_PEOPLE_MODES),
	enabled: z.boolean()
};

const secretSchema = z.string().min(1, 'Enter the client secret.').max(2000);

/** POST /api/identity-providers. */
export const createProviderRequestSchema = z.object({
	...providerFields,
	clientSecret: secretSchema
});

/** PATCH /api/identity-providers/<id>: the secret is kept unless a new one is sent. */
export const updateProviderRequestSchema = z.object({
	...providerFields,
	clientSecret: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('keep') }),
		z.object({ kind: z.literal('replace'), value: secretSchema })
	])
});

const identityProviderViewSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	kind: z.enum(PROVIDER_KINDS),
	issuer: z.string(),
	clientId: z.string(),
	hasClientSecret: z.boolean(),
	scopes: z.array(z.string()),
	newPeople: z.enum(NEW_PEOPLE_MODES),
	enabled: z.boolean(),
	createdIso: z.iso.datetime()
});

export const providerReplySchema = z.object({ provider: identityProviderViewSchema });
export const deletedReplySchema = z.object({ deleted: z.literal(true) });
