import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listDiagnosticsTokens } from '#lib/server/services/auth/diagnostics-tokens.ts';
import type { PageServerLoad } from './$types';

/** Settings → Diagnostics tokens (SPEC-AGENT-LOGS 4): every token, without its secret. Admins only. */
export const load: PageServerLoad = page.admin(() => ({
	tokens: listDiagnosticsTokens(database, Date.now())
}));
