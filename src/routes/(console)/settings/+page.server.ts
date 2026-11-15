import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { page } from '#lib/server/guards/page.ts';
import { localTlsStatus } from '#lib/server/services/agents/local-tls.ts';
import { recoveryFacts } from '#lib/server/services/settings/recovery.ts';
import { listSettings } from '#lib/server/services/settings/settings.ts';
import { servedCertificate } from '#lib/server/tls/served-certificate.ts';
import type { PageServerLoad } from './$types';

/**
 * Server settings (SPEC-SIGN-IN S16, SPEC-INSTALL-OPTIONS L1) and how to recover this server
 * (SPEC-SERVER-INSTALL I17); admins only.
 */
export const load: PageServerLoad = page.admin((_event, { user }) => ({
	settings: listSettings(database),
	localTls: localTlsStatus(database, servedCertificate()),
	recovery: recoveryFacts({
		launcher: env.launcher,
		databasePath: env.databasePath,
		releasesPath: env.releasesPath,
		backupSchedule: env.backupSchedule,
		email: user.email
	})
}));
