import { AGENT_TARGETS } from '#lib/domain/machines/agent-release.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { page } from '#lib/server/guards/page.ts';
import { localTlsStatus } from '#lib/server/services/agents/local-tls.ts';
import { agentDownload } from '#lib/server/services/agents/releases.ts';
import { servedCertificate } from '#lib/server/tls/served-certificate.ts';
import type { PageServerLoad } from './$types';

/**
 * Adding a machine makes a join code: admins only. Lists the agent builds for
 * manual installs (M2) and, in local network mode, the certificate pin (L5).
 */
export const load: PageServerLoad = page.admin(({ url }) => ({
	downloads: AGENT_TARGETS.map((target) => agentDownload(env.releasesPath, target, url.origin)),
	localTls: localTlsStatus(database, servedCertificate())
}));
