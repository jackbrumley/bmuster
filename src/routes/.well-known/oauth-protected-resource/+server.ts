import { route } from '#lib/server/guards/route.ts';
import { protectedResourceMetadata } from '#lib/server/services/oauth/metadata.ts';
import type { RequestHandler } from './$types';

/**
 * RFC 9728 protected resource metadata at the root path (SPEC-MCP M32): the same document as
 * `/.well-known/oauth-protected-resource/mcp`, for clients that probe the root first.
 */
export const GET: RequestHandler = route.oauth((_event, { origin }) =>
	Response.json(protectedResourceMetadata(origin))
);
