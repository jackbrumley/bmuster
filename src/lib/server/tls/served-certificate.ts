/**
 * What this process serves HTTPS with (SPEC-INSTALL-OPTIONS L4). Production:
 * hooks.server.ts decides at start-up and server.ts listens accordingly. The
 * dev server: the Vite plugin registers the certificate `vite dev` serves.
 * Kept on globalThis because server.ts, the built app and Vite's module
 * runners each load their own copy of this module.
 */
export type ServedCertificate =
	/** Plain HTTP; TLS is a reverse proxy's job (the normal set-up). */
	| { kind: 'plain' }
	/** Local network mode: the server's own certificate, from the database. */
	| { kind: 'own'; certificatePem: string; privateKeyPem: string }
	/** `npm run dev`: the development certificate Vite serves. */
	| { kind: 'dev'; certificatePem: string };

const REGISTRY_KEY = Symbol.for('bmuster.served-certificate');

export function registerServedCertificate(served: ServedCertificate): void {
	Reflect.set(globalThis, REGISTRY_KEY, served);
}

export function servedCertificate(): ServedCertificate {
	const served: unknown = Reflect.get(globalThis, REGISTRY_KEY);
	if (!isServedCertificate(served)) {
		throw new Error(
			'No served certificate was registered (hooks.server.ts init or vite-plugin.ts)'
		);
	}
	return served;
}

function isServedCertificate(value: unknown): value is ServedCertificate {
	if (typeof value !== 'object' || value === null || !('kind' in value)) {
		return false;
	}
	switch (value.kind) {
		case 'plain':
			return true;
		case 'own':
			return (
				'certificatePem' in value &&
				typeof value.certificatePem === 'string' &&
				'privateKeyPem' in value &&
				typeof value.privateKeyPem === 'string'
			);
		case 'dev':
			return 'certificatePem' in value && typeof value.certificatePem === 'string';
		default:
			return false;
	}
}
