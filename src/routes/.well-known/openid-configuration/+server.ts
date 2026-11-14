import { route } from '#lib/server/guards/route.ts';
import { authorizationServerMetadata } from '#lib/server/services/oauth/metadata.ts';
import type { RequestHandler } from './$types';

/**
 * The authorisation server metadata again, for clients that try OpenID discovery before RFC 8414
 * (SPEC-MCP M32). It claims no OpenID features: see `metadata.ts`.
 */
export const GET: RequestHandler = route.oauth((_event, { origin }) =>
	Response.json(authorizationServerMetadata(origin))
);
