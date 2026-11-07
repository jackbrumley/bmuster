import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listProviders } from '#lib/server/services/auth/identity-providers.ts';
import type { PageServerLoad } from './$types';

/** Sign-in providers (SPEC-SIGN-IN S9); admins only. Secrets never leave the server. */
export const load: PageServerLoad = page.admin(() => ({ providers: listProviders(database) }));
