/**
 * Whether an action that needs a recent sign-in (SPEC-COMMANDS C10) can go ahead now, and if
 * not, how the person proves it is them. Browser-safe.
 */
export type SignInCheck =
	| { kind: 'recent' }
	| { kind: 'password' }
	/** Two-factor is on: a code from the authenticator app instead of the password (SPEC-TWO-FACTOR 2.7). */
	| { kind: 'code' }
	/** Signs in only through a provider: a fresh sign-in is the only check BMuster can make. */
	| { kind: 'sign-in-again' };

/**
 * What the confirmation asks for to prove it is still the person: nothing, their password, or
 * a code from their authenticator app when two-factor is on (SPEC-TWO-FACTOR 2.7).
 */
export type RecheckAsk = 'none' | 'password' | 'code';

export function recheckAsk(check: SignInCheck): RecheckAsk {
	switch (check.kind) {
		case 'recent':
		case 'sign-in-again':
			return 'none';
		case 'password':
			return 'password';
		case 'code':
			return 'code';
	}
}
