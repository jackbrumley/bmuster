import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listSettings } from '#lib/server/services/settings/settings.ts';
import type { PageServerLoad } from './$types';

/** Server settings (SPEC-SIGN-IN S16); admins only. */
export const load: PageServerLoad = page.admin(() => ({ settings: listSettings(database) }));
