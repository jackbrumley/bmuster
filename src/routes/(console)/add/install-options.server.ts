import { AGENT_TARGETS, type AgentDownload } from '#lib/domain/machines/agent-release.ts';
import type { LocalTlsStatus } from '#lib/domain/settings/local-tls.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { localTlsStatus } from '#lib/server/services/agents/local-tls.ts';
import { agentDownload } from '#lib/server/services/agents/releases.ts';
import { servedCertificate } from '#lib/server/tls/served-certificate.ts';

/**
 * What the install commands need, on Add machine and on a machine's Reinstall
 * agent: the agent builds for a manual install (SPEC-INSTALL-OPTIONS M2) and,
 * in local network mode, the certificate pin the commands carry (L5).
 */
export function installOptions(origin: string): {
	downloads: AgentDownload[];
	localTls: LocalTlsStatus;
} {
	return {
		downloads: AGENT_TARGETS.map((target) => agentDownload(env.releasesPath, target, origin)),
		localTls: localTlsStatus(database, servedCertificate())
	};
}
