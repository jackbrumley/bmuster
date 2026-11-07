/**
 * Local network mode as the console shows it (SPEC-INSTALL-OPTIONS L3–L5).
 * Browser-safe.
 */

/** The certificate this server serves now, as people check it. */
export type ServedPin =
	| { kind: 'none' }
	/** `pin`: `sha256:<base64>` of the public key; `fingerprint`: the certificate's SHA-256 in hex. */
	| { kind: 'pin'; pin: string; fingerprint: string };

export type LocalTlsStatus = {
	/** The setting. */
	on: boolean;
	/** The listener or certificate changes when BMuster restarts. */
	restartNeeded: boolean;
	served: ServedPin;
};

/** The pin install commands carry: only in local network mode, and only once it is served. */
export function installPin(status: LocalTlsStatus): ServedPin {
	return status.on ? status.served : { kind: 'none' };
}
