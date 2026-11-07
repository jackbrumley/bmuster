/** How a newly added person hears about their account (SPEC-EMAIL E5). Browser-safe. */

/**
 * How the person will sign in: a password the admin sets now, a password
 * they choose through an invitation link, or a sign-in provider only.
 */
export type SignInChoice =
	{ kind: 'password'; value: string } | { kind: 'invite' } | { kind: 'provider' };

/**
 * What happened about telling them: an email went into the queue, or (with
 * email not set up) a link the admin passes on themselves, or nothing to send.
 */
export type Invitation =
	| { kind: 'none' }
	| { kind: 'emailed'; to: string }
	| { kind: 'link'; url: string; expiresIso: string };
