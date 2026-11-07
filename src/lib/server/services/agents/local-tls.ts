import { desc } from 'drizzle-orm';
import { hostname, networkInterfaces } from 'node:os';
import type { LocalTlsStatus } from '#lib/domain/settings/local-tls.ts';
import type { ServerSocketMessage, ServerTrust } from '#lib/schemas/agents/agent-protocol.ts';
import { localCertificates } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { openSecret, sealSecret } from '../../crypto/secret-box.ts';
import {
	certificatePin,
	makeSelfSignedCertificate,
	type CertificateNames
} from '../../crypto/self-signed-certificate.ts';
import type { ServedCertificate } from '../../tls/served-certificate.ts';
import { recordAudit } from '../audit/audit.ts';
import { getSetting } from '../settings/settings.ts';
import { sendToAllAgents } from './live-agents.ts';

/**
 * Local network mode (SPEC-INSTALL-OPTIONS L4, L7): the certificate the server
 * makes and keeps, what it serves at start-up, and the pin announcements
 * that let agents follow a certificate change without losing trust.
 */
type LocalCertificate = { certificatePem: string; privateKeyPem: string; pin: string };

/**
 * The names a new certificate is made for: this computer's hostname (and its
 * `.local` mDNS name), `localhost`, and every LAN address it has right now.
 * Addresses that change later are not followed automatically; renewing the
 * certificate picks up the new set.
 */
export function lanCertificateNames(): CertificateNames {
	const host = hostname();
	const ipAddresses = new Set<string>(['127.0.0.1', '::1']);
	for (const addresses of Object.values(networkInterfaces())) {
		for (const address of addresses ?? []) {
			// Link-local IPv6 needs a zone (`%eth0`) that neither URLs nor certificates carry.
			if (!address.internal && !address.address.toLowerCase().startsWith('fe80:')) {
				ipAddresses.add(address.address);
			}
		}
	}
	const dnsNames = new Set([host, 'localhost']);
	if (!host.includes('.')) {
		dnsNames.add(`${host}.local`);
	}
	return { commonName: host, dnsNames: [...dnsNames], ipAddresses: [...ipAddresses] };
}

function newestRow(database: Queryable) {
	return database
		.select()
		.from(localCertificates)
		.orderBy(desc(localCertificates.createdAt))
		.limit(1)
		.get();
}

function insertCertificate(
	database: Queryable,
	secretsKey: Buffer,
	names: CertificateNames,
	now: number
): LocalCertificate {
	const made = makeSelfSignedCertificate(names, now);
	const { pin } = certificatePin(made.certificatePem);
	database
		.insert(localCertificates)
		.values({
			id: crypto.randomUUID(),
			certificatePem: made.certificatePem,
			privateKeyEncrypted: sealSecret(Buffer.from(made.privateKeyPem, 'utf8'), secretsKey),
			pin,
			createdAt: new Date(now)
		})
		.run();
	return { ...made, pin };
}

/** The newest certificate, made on first use. */
export function localCertificate(
	database: Queryable,
	secretsKey: Buffer,
	names: CertificateNames,
	now: number
): LocalCertificate {
	const row = newestRow(database);
	if (row === undefined) {
		return insertCertificate(database, secretsKey, names, now);
	}
	return {
		certificatePem: row.certificatePem,
		privateKeyPem: openSecret(row.privateKeyEncrypted, secretsKey).toString('utf8'),
		pin: row.pin
	};
}

/**
 * At start-up (production): serve the server's own certificate in local
 * network mode, otherwise plain HTTP behind a reverse proxy.
 */
export function startupServedCertificate(
	database: Queryable,
	secretsKey: Buffer,
	names: CertificateNames,
	now: number
): ServedCertificate {
	if (!getSetting(database, 'localNetworkMode')) {
		return { kind: 'plain' };
	}
	const certificate = localCertificate(database, secretsKey, names, now);
	return {
		kind: 'own',
		certificatePem: certificate.certificatePem,
		privateKeyPem: certificate.privateKeyPem
	};
}

/** How agents check the certificate this process serves now. */
function servedTrust(served: ServedCertificate): ServerTrust {
	switch (served.kind) {
		case 'plain':
			return { kind: 'public' };
		case 'own':
		case 'dev':
			return { kind: 'pin', pin: certificatePin(served.certificatePem).pin };
	}
}

/**
 * How agents must check the certificate after the next restart. The dev
 * server always serves Vite's certificate, whatever the setting says.
 */
function nextTrust(database: Queryable, served: ServedCertificate): ServerTrust {
	if (served.kind === 'dev') {
		return servedTrust(served);
	}
	if (!getSetting(database, 'localNetworkMode')) {
		return { kind: 'public' };
	}
	const row = newestRow(database);
	if (row === undefined) {
		throw new Error('Local network mode is on but there is no certificate (local_certificates)');
	}
	return { kind: 'pin', pin: row.pin };
}

function sameTrust(a: ServerTrust, b: ServerTrust): boolean {
	return a.kind === 'public' ? b.kind === 'public' : b.kind === 'pin' && a.pin === b.pin;
}

/**
 * The pin announcement every agent gets when its socket opens and whenever
 * the next certificate changes (L7). When nothing is about to change it names
 * the current certificate, which tells the agent to forget any older plan.
 */
export function pinUpdate(database: Queryable, served: ServedCertificate): ServerSocketMessage {
	return { type: 'pin-update', next: nextTrust(database, served) };
}

/**
 * After local network mode is switched on or off: make sure the certificate
 * exists before anyone restarts the server, then tell every connected agent
 * what to expect.
 */
export function localNetworkModeChanged(
	database: AppDatabase,
	secretsKey: Buffer,
	served: ServedCertificate,
	names: CertificateNames,
	now: number
): void {
	if (getSetting(database, 'localNetworkMode')) {
		localCertificate(database, secretsKey, names, now);
	}
	sendToAllAgents(pinUpdate(database, served));
}

/**
 * Makes a new certificate (new key, current LAN names), served from the next
 * restart. Agents are told its pin now, over their trusted connection.
 */
export function renewLocalCertificate(
	database: AppDatabase,
	secretsKey: Buffer,
	served: ServedCertificate,
	names: CertificateNames,
	actorUserId: string,
	now: number
): void {
	database.transaction((transaction) => {
		const made = insertCertificate(transaction, secretsKey, names, now);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'local-certificate-renewed',
				target: 'Local network certificate',
				detail: { pin: made.pin }
			},
			now
		);
	});
	sendToAllAgents(pinUpdate(database, served));
}

/** What the Settings and Add machine pages show about local network mode. */
export function localTlsStatus(database: Queryable, served: ServedCertificate): LocalTlsStatus {
	const on = getSetting(database, 'localNetworkMode');
	const restartNeeded = !sameTrust(servedTrust(served), nextTrust(database, served));
	switch (served.kind) {
		case 'plain':
			return { on, restartNeeded, served: { kind: 'none' } };
		case 'own':
		case 'dev':
			return {
				on,
				restartNeeded,
				served: { kind: 'pin', ...certificatePin(served.certificatePem) }
			};
	}
}
