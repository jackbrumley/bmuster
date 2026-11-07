import { and, eq, isNull } from 'drizzle-orm';
import { browserFingerprint, type LocalPageInfo } from '#lib/domain/machines/local-page.ts';
import type { LocalPageReport } from '#lib/schemas/agents/agent-protocol.ts';
import type { LocalCodeReply } from '#lib/schemas/machines/local-page.ts';
import { machineLocalPages, machines } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { openSecret, sealSecret } from '../../crypto/secret-box.ts';
import { localUserSecret, totpCode, totpSecondsLeft } from '../../crypto/totp.ts';
import { localPagePeople } from '../access/access.ts';
import { recordAudit } from '../audit/audit.ts';
import type { AuthenticatedAgent } from './agent-auth.ts';

/**
 * The agent's local page (SPEC-AGENT-LOCAL): the agent sends its sign-in
 * secret and certificate once (signed); admins see the current code.
 */

/** Viewing the code is audited at most once a minute per admin and machine. */
const VIEW_AUDIT_EVERY_MS = 60_000;

/** Stores what the agent reported, replacing an earlier report. The secret is sealed. */
export function storeLocalPage(
	database: AppDatabase,
	agent: AuthenticatedAgent,
	report: LocalPageReport,
	secretsKey: Buffer,
	now: number
): void {
	const row = {
		totpSecretSealed: sealSecret(Buffer.from(report.totpSecret, 'base64'), secretsKey),
		certificateSha256: report.certificateSha256,
		port: report.port,
		reportedAt: new Date(now)
	};
	database
		.insert(machineLocalPages)
		.values({ machineId: agent.machineId, ...row })
		.onConflictDoUpdate({ target: machineLocalPages.machineId, set: row })
		.run();
}

/** What the Manage tab shows about a machine's local page. */
export function localPageInfo(database: AppDatabase, machineId: string): LocalPageInfo {
	const row = database
		.select()
		.from(machineLocalPages)
		.where(eq(machineLocalPages.machineId, machineId))
		.get();
	if (row === undefined) {
		return { kind: 'none' };
	}
	return {
		kind: 'reported',
		address: `https://localhost:${row.port}`,
		fingerprint: browserFingerprint(row.certificateSha256),
		reportedIso: row.reportedAt.toISOString()
	};
}

/**
 * When each (database, admin, machine) last had a view audited. Process-local, like the live
 * sockets: BMuster runs as one instance, and a restart audits the next view again.
 */
const lastAudited = new WeakMap<AppDatabase, Map<string, number>>();

function auditDue(database: AppDatabase, key: string, now: number): boolean {
	let seen = lastAudited.get(database);
	if (seen === undefined) {
		seen = new Map();
		lastAudited.set(database, seen);
	}
	const last = seen.get(key);
	if (last !== undefined && now - last < VIEW_AUDIT_EVERY_MS) {
		return false;
	}
	seen.set(key, now);
	return true;
}

/**
 * The local page's current code for an admin, and the seconds until it changes. Undefined for
 * an unknown or removed machine. An agent that takes per-person codes gets the viewer's own code
 * (SPEC-AGENT-LOCAL 7) and never the shared one; an older agent still gets the shared code. The
 * view is audited (`local-code-viewed`), at most once a minute per admin and machine, so a
 * countdown that fetches every 30 seconds is one entry.
 */
export function viewLocalCode(
	database: AppDatabase,
	machineId: string,
	viewerId: string,
	secretsKey: Buffer,
	now: number
): LocalCodeReply | undefined {
	const row = database
		.select({
			name: machines.name,
			hostname: machines.hostname,
			localCodes: machines.localCodes,
			sealed: machineLocalPages.totpSecretSealed
		})
		.from(machines)
		.leftJoin(machineLocalPages, eq(machineLocalPages.machineId, machines.id))
		.where(and(eq(machines.id, machineId), isNull(machines.removedAt)))
		.get();
	if (row === undefined) {
		return undefined;
	}
	if (row.sealed === null) {
		return { kind: 'not-reported' };
	}
	const perPerson = row.localCodes === 'per-person';
	if (perPerson && !localPagePeople(database).some((person) => person.userId === viewerId)) {
		return { kind: 'not-listed' };
	}
	if (auditDue(database, `${viewerId}:${machineId}`, now)) {
		recordAudit(
			database,
			{
				actor: { kind: 'user', userId: viewerId },
				kind: 'local-code-viewed',
				target: row.name,
				machineId,
				detail: { hostname: row.hostname, code: perPerson ? 'their own' : 'shared' }
			},
			now
		);
	}
	const seconds = now / 1000;
	const machineSecret = openSecret(row.sealed, secretsKey);
	return {
		kind: 'code',
		code: totpCode(perPerson ? localUserSecret(machineSecret, viewerId) : machineSecret, seconds),
		secondsLeft: totpSecondsLeft(seconds),
		scope: perPerson ? 'person' : 'machine'
	};
}
