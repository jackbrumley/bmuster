import { createHash, generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import {
	derBitString,
	derBoolean,
	derExplicit,
	derImplicitPrimitive,
	derObjectId,
	derOctetString,
	derSequence,
	derSet,
	derSmallInteger,
	derTime,
	derUnsignedInteger,
	derUtf8String
} from './der.ts';

/**
 * The certificate BMuster makes for local network mode (SPEC-INSTALL-OPTIONS
 * L4): ECDSA P-256 (every browser and the agent's rustls accept it; Ed25519
 * certificates are refused by browsers), self-signed, a leaf only (not a CA,
 * so it cannot vouch for anything else), valid for ten years.
 */
export type SelfSignedCertificate = {
	certificatePem: string;
	/** PKCS #8 PEM. */
	privateKeyPem: string;
};

export type CertificateNames = {
	commonName: string;
	dnsNames: readonly string[];
	ipAddresses: readonly string[];
};

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const COMMON_NAME = '2.5.4.3';
const ORGANISATION = '2.5.4.10';
const BASIC_CONSTRAINTS = '2.5.29.19';
const KEY_USAGE = '2.5.29.15';
const EXTENDED_KEY_USAGE = '2.5.29.37';
const SUBJECT_ALT_NAME = '2.5.29.17';
const SUBJECT_KEY_IDENTIFIER = '2.5.29.14';
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1';

const VALID_YEARS = 10;
/** Starts an hour early, so a client whose clock runs a little slow still accepts it. */
const BACKDATE_MS = 60 * 60 * 1000;

export function makeSelfSignedCertificate(
	names: CertificateNames,
	now: number
): SelfSignedCertificate {
	const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const spki = publicKey.export({ format: 'der', type: 'spki' });
	const name = derSequence(
		derSet(derSequence(derObjectId(ORGANISATION), derUtf8String('BMuster'))),
		derSet(derSequence(derObjectId(COMMON_NAME), derUtf8String(names.commonName)))
	);
	const notBefore = new Date(now - BACKDATE_MS);
	const notAfter = new Date(now);
	notAfter.setUTCFullYear(notAfter.getUTCFullYear() + VALID_YEARS);
	const signatureAlgorithm = derSequence(derObjectId(ECDSA_WITH_SHA256));
	// Serial: 16 random bytes, top bit cleared so it stays a positive 128-bit number.
	const serial = randomBytes(16);
	serial[0] = (serial[0] ?? 0) & 0x7f;

	const tbs = derSequence(
		derExplicit(0, derSmallInteger(2)),
		derUnsignedInteger(serial),
		signatureAlgorithm,
		name,
		derSequence(derTime(notBefore), derTime(notAfter)),
		name,
		spki,
		derExplicit(
			3,
			derSequence(
				extension(BASIC_CONSTRAINTS, true, derSequence()),
				// digitalSignature only: the bit string 1000 0000 with 7 unused bits.
				extension(KEY_USAGE, true, derBitString(Buffer.from([0x80]), 7)),
				extension(EXTENDED_KEY_USAGE, false, derSequence(derObjectId(SERVER_AUTH))),
				extension(SUBJECT_KEY_IDENTIFIER, false, derOctetString(keyIdentifier(spki))),
				extension(SUBJECT_ALT_NAME, false, subjectAltNames(names))
			)
		)
	);
	const signature = sign('sha256', tbs, privateKey);
	const certificate = derSequence(tbs, signatureAlgorithm, derBitString(signature, 0));
	return {
		certificatePem: toPem('CERTIFICATE', certificate),
		privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' })
	};
}

function extension(oid: string, critical: boolean, value: Buffer): Buffer {
	return critical
		? derSequence(derObjectId(oid), derBoolean(true), derOctetString(value))
		: derSequence(derObjectId(oid), derOctetString(value));
}

/** RFC 5280 4.2.1.2 method 1: SHA-1 of the public key bits (an identifier, not a security check). */
function keyIdentifier(spki: Buffer): Buffer {
	return createHash('sha1').update(spki).digest();
}

function subjectAltNames(names: CertificateNames): Buffer {
	const dns = names.dnsNames.map((dnsName) =>
		derImplicitPrimitive(2, Buffer.from(dnsName, 'ascii'))
	);
	const ips = names.ipAddresses.map((address) => derImplicitPrimitive(7, ipBytes(address)));
	return derSequence(...dns, ...ips);
}

function ipBytes(address: string): Buffer {
	if (isIPv4(address)) {
		return Buffer.from(address.split('.').map((part) => Number.parseInt(part, 10)));
	}
	if (!isIPv6(address) || address.includes('.')) {
		throw new Error(`Not an IP address a certificate can name: ${address}`);
	}
	const [head = '', tail] = address.split('::');
	const headGroups = head === '' ? [] : head.split(':');
	const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':');
	const missing = 8 - headGroups.length - tailGroups.length;
	const groups = [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups];
	const bytes = Buffer.alloc(16);
	groups.forEach((group, index) => {
		bytes.writeUInt16BE(Number.parseInt(group, 16), index * 2);
	});
	return bytes;
}

function toPem(label: string, der: Buffer): string {
	const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/**
 * How a certificate is checked by hand (SPEC-INSTALL-OPTIONS L5). `pin` is
 * `sha256:` and the base64 SHA-256 of the DER SubjectPublicKeyInfo: the value
 * curl's `--pinnedpubkey sha256//…` takes and the agent's `--pin-cert`
 * checks. `fingerprint` is the SHA-256 of the whole certificate in hex, as
 * browsers show it in the certificate details.
 */
export type CertificatePin = { pin: string; fingerprint: string };

export function certificatePin(certificatePem: string): CertificatePin {
	const certificate = new X509Certificate(certificatePem);
	const spki = certificate.publicKey.export({ format: 'der', type: 'spki' });
	return {
		pin: `sha256:${createHash('sha256').update(spki).digest('base64')}`,
		fingerprint: certificate.fingerprint256
	};
}
