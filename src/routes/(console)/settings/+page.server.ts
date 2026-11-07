import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { localTlsStatus } from '#lib/server/services/agents/local-tls.ts';
import { listSettings } from '#lib/server/services/settings/settings.ts';
import { servedCertificate } from '#lib/server/tls/served-certificate.ts';
import type { PageServerLoad } from './$types';

/** Server settings (SPEC-SIGN-IN S16, SPEC-INSTALL-OPTIONS L1); admins only. */
export const load: PageServerLoad = page.admin(() => ({
	settings: listSettings(database),
	localTls: localTlsStatus(database, servedCertificate())
}));
