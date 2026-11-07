import { linuxInstallScript } from '#lib/server/services/agents/install-scripts.ts';
import { route } from '#lib/server/guards/route.ts';
import type { RequestHandler } from './$types';

/** GET /install.sh: the Linux installer, pointing back at this server. */
export const GET: RequestHandler = route.public(
	({ url }) =>
		new Response(linuxInstallScript(url.origin), {
			headers: { 'content-type': 'text/x-shellscript; charset=utf-8' }
		})
);
