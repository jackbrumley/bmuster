import type { ConsoleRole } from '../users/user.ts';

/** Two-factor sign-in (SPEC-TWO-FACTOR). Browser-safe. */

/** The server setting (2.1): who must use it. */
export const TWO_FACTOR_POLICIES = ['off', 'admins', 'everyone'] as const;

export type TwoFactorPolicy = (typeof TWO_FACTOR_POLICIES)[number];

/** Whether the setting makes someone with this role use it (when they sign in with a password). */
export function twoFactorRequired(policy: TwoFactorPolicy, role: ConsoleRole): boolean {
	switch (policy) {
		case 'off':
			return false;
		case 'admins':
			return role === 'admin';
		case 'everyone':
			return true;
	}
}

/** How many recovery codes a set holds. */
export const RECOVERY_CODE_COUNT = 10;

/** A QR code as one SVG path: `size` modules square, quiet zone included. */
export type QrPicture = { size: number; path: string };

/** What set-up shows: the QR code, and the key in groups of four for typing in by hand. */
export type TwoFactorKey = { otpauthUri: string; keyText: string; qr: QrPicture };

/** The Account page's view of the signed-in person's two-factor sign-in (2.6). */
export type TwoFactorStatus =
	| { kind: 'no-password'; providerNames: string[] }
	| { kind: 'off'; required: boolean }
	| { kind: 'on'; sinceIso: string; recoveryCodesLeft: number; required: boolean };

/** What the person types at the code step or the re-check: six digits, or a recovery code. */
export const SIX_DIGITS = /^\d{6}$/;

/** The text of the recovery codes download (`bmuster-recovery-codes.txt`). */
export function recoveryCodesText(codes: readonly string[], email: string, origin: string): string {
	return [
		`BMuster recovery codes for ${email}`,
		origin,
		'',
		'Each code signs you in once if you cannot use your authenticator app.',
		'Keep them somewhere safe, away from your phone.',
		'',
		...codes,
		''
	].join('\n');
}
