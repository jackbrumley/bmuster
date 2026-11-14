import { route } from '#lib/server/guards/route.ts';
import { protectedResourceMetadata } from '#lib/server/services/oauth/metadata.ts';
import type { RequestHandler } from './$types';

/** RFC 9728 protected resource metadata for /mcp (SPEC-MCP M5). */
export const GET: RequestHandler = route.oauth((_event, { origin }) =>
	Response.json(protectedResourceMetadata(origin))
);
