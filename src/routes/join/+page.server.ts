import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { organisationName } from '#lib/server/services/settings/settings.ts';
import type { PageServerLoad } from './$types';

/**
 * The public enrolment page (SPEC-JOIN). Before a valid code it exposes
 * only the organisation name (J5); the rest comes from /join/check and
 * /join/install once a code is typed.
 */
export const load: PageServerLoad = page.public(({ url }) => ({
	organisation: organisationName(database, url.hostname)
}));
