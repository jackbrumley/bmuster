import { page } from '#lib/server/guards/page.ts';
import { installOptions } from '../../../add/install-options.server.ts';
import type { PageServerLoad } from './$types';

/** Manage: Reinstall agent shows the same install commands as Add machine (SPEC-MACHINE-DETAILS D9). */
export const load: PageServerLoad = page.admin(({ url }) => installOptions(url.origin));
