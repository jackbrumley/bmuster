/**
 * Whether an action that needs a recent sign-in (SPEC-COMMANDS C10) can go ahead now, and if
 * not, how the person proves it is them. Browser-safe.
 */
export type SignInCheck =
	| { kind: 'recent' }
	| { kind: 'password' }
	/** Signs in only through a provider: a fresh sign-in is the only check BMuster can make. */
	| { kind: 'sign-in-again' };
