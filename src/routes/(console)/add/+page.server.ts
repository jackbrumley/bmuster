import { page } from '#lib/server/guards/page.ts';
import { installOptions } from './install-options.server.ts';
import type { PageServerLoad } from './$types';

/**
 * Adding a machine makes a join code: admins only. Lists the agent builds for
 * manual installs (M2) and, in local network mode, the certificate pin (L5).
 */
export const load: PageServerLoad = page.admin(({ url }) => installOptions(url.origin));
