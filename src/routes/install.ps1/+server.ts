import { windowsInstallScript } from '#lib/server/services/agents/install-scripts.ts';
import type { RequestHandler } from './$types';

/** GET /install.ps1: the Windows installer, pointing back at this server. */
export const GET: RequestHandler = ({ url }) =>
	new Response(windowsInstallScript(url.origin), {
		headers: { 'content-type': 'text/plain; charset=utf-8' }
	});
