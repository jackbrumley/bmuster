import { createPrivateKey, X509Certificate } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { connect } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { localCertificates } from '#lib/server/database/schema.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { certificatePin, makeSelfSignedCertificate } from '../../crypto/self-signed-certificate.ts';
import { updateSetting } from '../settings/settings.ts';
import {
	lanCertificateNames,
	localCertificate,
	localTlsStatus,
	startupServedCertificate
} from './local-tls.ts';

const KEY = Buffer.alloc(32, 3);
const NAMES = {
	commonName: 'office-server',
	dnsNames: ['office-server', 'localhost'],
	ipAddresses: ['127.0.0.1', '192.168.1.20', 'fd00::20']
};

/** Made with `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256`; pin and fingerprint from openssl too. */
const OPENSSL_CERTIFICATE = `-----BEGIN CERTIFICATE-----
MIIBeDCCAR+gAwIBAgIUKfEluGP8WZ7TGHy7l/0xa/FNYDowCgYIKoZIzj0EAwIw
EjEQMA4GA1UEAwwHZml4dHVyZTAeFw0yNjExMDcwMTQ1NTVaFw0zNjExMDQwMTQ1
NTVaMBIxEDAOBgNVBAMMB2ZpeHR1cmUwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNC
AAQMR9VSkoDNnUX8LZEYl/YU307sfi3xzcbHh6rUXCg1Qh6nG9l337d9wS6DuYmq
MWg+72Rp9hDxrbWBcgTuEojJo1MwUTAdBgNVHQ4EFgQUpr4nsLMB1x70ojej7YUV
2pJc3qIwHwYDVR0jBBgwFoAUpr4nsLMB1x70ojej7YUV2pJc3qIwDwYDVR0TAQH/
BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiBxRSioKXUZcGW7/vYfH3D6nskDI7Fi
Yo+urVGuQ0RJ/QIgUz9/FRPqncHdRcqoYEBDlDYxuM6B0jWhl0L99Zc4iBU=
-----END CERTIFICATE-----
`;

/** The pin of the certificate a TLS server actually presents. */
async function presentedPin(server: Server): Promise<string> {
	const address = server.address();
	if (address === null || typeof address === 'string') throw new Error('not listening on TCP');
	const { port } = address;
	return new Promise((resolve, reject) => {
		const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
			const peer = socket.getPeerX509Certificate();
			socket.end();
			if (peer === undefined) {
				reject(new Error('no peer certificate'));
				return;
			}
			resolve(certificatePin(peer.toString()).pin);
		});
		socket.on('error', reject);
	});
}

describe('local network certificate (L4, L5)', () => {
	it('L5: the pin is the SHA-256 of the public key, as curl and openssl compute it', () => {
		expect(certificatePin(OPENSSL_CERTIFICATE)).toEqual({
			pin: 'sha256:1r5zEexfbywjgNu6ZRpu+AS7CsXowKxeydbXmQ8Gwl8=',
			fingerprint:
				'56:AD:EA:80:72:39:7A:E7:B4:67:B1:55:5B:9B:A6:07:64:65:70:32:5B:36:C8:E9:13:82:63:76:82:E8:82:A3'
		});
	});

	it('L4: makes a ten-year, self-signed P-256 server certificate for its LAN names', () => {
		const made = makeSelfSignedCertificate(NAMES, NOW);
		const certificate = new X509Certificate(made.certificatePem);
		expect(certificate.verify(certificate.publicKey)).toBe(true);
		expect(certificate.checkPrivateKey(createPrivateKey(made.privateKeyPem))).toBe(true);
		expect(certificate.publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
		expect(certificate.ca).toBe(false);
		expect(certificate.subject).toContain('CN=office-server');
		expect(certificate.subjectAltName).toBe(
			'DNS:office-server, DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.1.20, IP Address:FD00:0:0:0:0:0:0:20'
		);
		expect(certificate.checkHost('office-server')).toBe('office-server');
		expect(certificate.checkIP('192.168.1.20')).toBe('192.168.1.20');
		const from = new Date(certificate.validFrom).getTime();
		const to = new Date(certificate.validTo).getTime();
		expect(from).toBeLessThanOrEqual(NOW);
		expect(new Date(to).getUTCFullYear() - new Date(NOW).getUTCFullYear()).toBe(10);
		expect(certificate.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
	});

	it('L4: names this computer, localhost and its LAN addresses', () => {
		const names = lanCertificateNames();
		expect(names.dnsNames).toContain('localhost');
		expect(names.dnsNames.length).toBeGreaterThan(1);
		expect(names.ipAddresses).toContain('127.0.0.1');
		expect(names.ipAddresses.some((address) => address.toLowerCase().startsWith('fe80:'))).toBe(
			false
		);
	});

	it('L4: keeps one certificate, its private key sealed with SECRETS_KEY', () => {
		const database = testDatabase();
		const first = localCertificate(database, KEY, NAMES, NOW);
		const again = localCertificate(database, KEY, NAMES, NOW + 1000);
		expect(again).toEqual(first);
		const rows = database.select().from(localCertificates).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.privateKeyEncrypted).not.toContain('PRIVATE KEY');
		expect(rows[0]?.pin).toBe(certificatePin(first.certificatePem).pin);
		expect(() => localCertificate(database, Buffer.alloc(32, 4), NAMES, NOW)).toThrow();
	});

	it('L4: serves plain HTTP when off, and HTTPS with its own certificate when on', async () => {
		const database = testDatabase();
		expect(startupServedCertificate(database, KEY, NAMES, NOW)).toEqual({ kind: 'plain' });
		const admin = await addTestUser(database, {
			email: 'a@example.com',
			role: 'admin',
			password: null
		});
		updateSetting(database, admin.id, 'localNetworkMode', true, NOW);
		const served = startupServedCertificate(database, KEY, NAMES, NOW);
		if (served.kind !== 'own') throw new Error('expected the own certificate');
		const { pin } = localCertificate(database, KEY, NAMES, NOW);
		expect(localTlsStatus(database, served)).toEqual({
			on: true,
			restartNeeded: false,
			served: { kind: 'pin', ...certificatePin(served.certificatePem) }
		});

		const server = createServer({ cert: served.certificatePem, key: served.privateKeyPem });
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			expect(await presentedPin(server)).toBe(pin);
		} finally {
			server.close();
		}
	});
});
