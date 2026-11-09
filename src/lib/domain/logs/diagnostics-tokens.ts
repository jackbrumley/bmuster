/** Read-only diagnostics tokens (SPEC-AGENT-LOGS 4), as Settings shows them. Browser-safe. */

export const DIAGNOSTICS_TOKEN_PREFIX = 'bmd_';

export const DIAGNOSTICS_TOKEN_DAYS = [1, 7, 30, 90] as const;
export type DiagnosticsTokenDays = (typeof DIAGNOSTICS_TOKEN_DAYS)[number];

export type DiagnosticsTokenView = {
	id: string;
	name: string;
	/** The admin who made it; it works only while they are an enabled admin. */
	ownerName: string;
	createdIso: string;
	expiresIso: string;
	lastUsed: { kind: 'never' } | { kind: 'used'; atIso: string };
	state: 'active' | 'expired' | 'revoked';
};

export function tokenStateLabel(state: DiagnosticsTokenView['state']): string {
	switch (state) {
		case 'active':
			return 'Active';
		case 'expired':
			return 'Expired';
		case 'revoked':
			return 'Revoked';
	}
}
