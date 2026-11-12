import { route } from '#lib/server/guards/route.ts';
import type { RequestHandler } from './$types';

/**
 * GET /s/<token>/status: the guest page asks now and then, so it shows
 * "This link has ended" as soon as the link is ended or its creator loses
 * access. An ended link gets the guard's plain 404.
 */
export const GET: RequestHandler = route.guest((_event, { grant }) =>
	Response.json(
		{ kind: 'active', expiresIso: new Date(grant.expiresAt).toISOString() },
		{ headers: { 'cache-control': 'no-store' } }
	)
);
