import { z } from 'zod';

/**
 * The OAuth wire formats BMuster's authorisation server reads (SPEC-MCP 8). Names are the
 * protocol's own (snake_case), fixed by RFC 6749, 7591, 7009 and the Client ID Metadata
 * Document draft; optional fields are optional because the protocols say so.
 */

const uri = z.string().min(1).max(2000);

/** A client's metadata, from its document (CIMD) or its registration request (DCR). */
const clientMetadataFields = {
	client_name: z.string().trim().min(1).max(100).optional(),
	client_uri: uri.optional(),
	logo_uri: uri.optional(),
	redirect_uris: z.array(uri).min(1).max(20),
	token_endpoint_auth_method: z.string().max(100).optional(),
	grant_types: z.array(z.string().max(100)).max(10).optional(),
	response_types: z.array(z.string().max(100)).max(10).optional(),
	scope: z.string().max(1000).optional()
};

/**
 * A document may list every method it can use; ChatGPT's names `private_key_jwt` as its
 * preference and lists `none` beside it, and picks from what the server offers (SPEC-MCP M34).
 */
export const clientMetadataDocumentSchema = z.object({
	client_id: uri,
	token_endpoint_auth_methods_supported: z.array(z.string().max(100)).max(10).optional(),
	...clientMetadataFields
});

export type ClientMetadataDocument = z.infer<typeof clientMetadataDocumentSchema>;

export const registrationRequestSchema = z.object(clientMetadataFields);

/** `/oauth/authorize`'s query (and the consent form's hidden fields): checked in order later. */
export const authorizeParamsSchema = z.object({
	response_type: z.string().max(100).optional(),
	client_id: z.string().max(2000).optional(),
	redirect_uri: z.string().max(2000).optional(),
	code_challenge: z.string().max(200).optional(),
	code_challenge_method: z.string().max(100).optional(),
	state: z.string().max(2000).optional(),
	resource: z.string().max(2000).optional(),
	scope: z.string().max(1000).optional()
});

export type AuthorizeParams = z.infer<typeof authorizeParamsSchema>;

/** PKCE: 43 to 128 characters from the unreserved set (RFC 7636 4.1). */
export const PKCE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/** S256 of a verifier: 43 base64url characters. */
export const PKCE_CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

export const tokenRequestSchema = z.discriminatedUnion('grant_type', [
	z.object({
		grant_type: z.literal('authorization_code'),
		code: z.string().min(1).max(200),
		redirect_uri: z.string().min(1).max(2000),
		code_verifier: z.string().min(1).max(200),
		client_id: z.string().min(1).max(2000),
		resource: z.string().max(2000).optional()
	}),
	z.object({
		grant_type: z.literal('refresh_token'),
		refresh_token: z.string().min(1).max(200),
		client_id: z.string().min(1).max(2000),
		resource: z.string().max(2000).optional(),
		scope: z.string().max(1000).optional()
	})
]);

export type TokenRequest = z.infer<typeof tokenRequestSchema>;

export const revokeRequestSchema = z.object({
	token: z.string().min(1).max(200),
	token_type_hint: z.string().max(100).optional(),
	client_id: z.string().max(2000).optional()
});
