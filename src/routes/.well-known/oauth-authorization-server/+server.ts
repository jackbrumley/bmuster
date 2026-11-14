import { route } from '#lib/server/guards/route.ts';
import { authorizationServerMetadata } from '#lib/server/services/oauth/metadata.ts';
import type { RequestHandler } from './$types';

/** RFC 8414 authorisation server metadata (SPEC-MCP M5). */
export const GET: RequestHandler = route.oauth((_event, { origin }) =>
	Response.json(authorizationServerMetadata(origin))
);
