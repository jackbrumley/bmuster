/**
 * The agent's local page as the console shows it (SPEC-AGENT-LOCAL).
 * Browser-safe.
 */
export type LocalPageInfo =
	/** The agent has not reported a local page (an older agent). */
	| { kind: 'none' }
	| {
			kind: 'reported';
			/** The address to open on the machine itself. */
			address: string;
			/** The certificate's SHA-256 as browsers show it: `AB:CD:…`. */
			fingerprint: string;
			reportedIso: string;
	  };

/** `AB:CD:…` from lower-case hex. */
export function browserFingerprint(sha256Hex: string): string {
	return (sha256Hex.toUpperCase().match(/../g) ?? []).join(':');
}
