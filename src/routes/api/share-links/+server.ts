import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { listAllActiveShareLinks } from '#lib/server/services/share-links/share-links.ts';
import type { RequestHandler } from './$types';

/** Every active share link on the server, for admins (SPEC-SHARE-LINKS SL15). */
export const GET: RequestHandler = route.admin(() =>
	Response.json({ links: listAllActiveShareLinks(database, Date.now()) })
);
