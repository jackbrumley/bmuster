import { page } from '#lib/server/guards/page.ts';
import type { PageServerLoad } from './$types';

/** Adding a machine makes a join code: admins only. */
export const load: PageServerLoad = page.admin(() => ({}));
