import { resolve } from '$app/paths';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import {
	createShareLink,
	listMachineShareLinks
} from '#lib/server/services/share-links/share-links.ts';
import { createShareLinkRequestSchema } from '#lib/schemas/share-links/share-links.ts';
import { invalidRequest, readJson } from '../../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * A machine's share links (SPEC-SHARE-LINKS SL2–SL4, SL15). Both need
 * `share-links` on the machine, checked by the service through the access
 * service; a machine the person cannot see is 404.
 */
export const GET: RequestHandler = route.user(({ params }, { user }) => {
	const result = listMachineShareLinks(database, user, params.id, Date.now());
	switch (result.kind) {
		case 'ok':
			return Response.json({ links: result.links, canTick: result.canTick });
		case 'refused':
			return Response.json({ message: result.message }, { status: result.status });
	}
});

/** Creates a link; the reply is the only place its token ever appears. */
export const POST: RequestHandler = route.user(async (event, { user }) => {
	const parsed = createShareLinkRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const result = createShareLink(database, user, event.params.id, parsed.data, Date.now());
	switch (result.kind) {
		case 'created':
			return Response.json(
				{
					link: result.link,
					url: `${event.url.origin}${resolve('/s/[token]', { token: result.token })}`
				},
				{ status: 201, headers: { 'cache-control': 'no-store' } }
			);
		case 'refused':
			return Response.json({ message: result.message }, { status: result.status });
	}
});
