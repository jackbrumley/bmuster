import { describe, expect, it } from 'vitest';
import { activityLabel, isAuditKind } from './activity.ts';

describe('two-factor entries on Activity (SPEC-TWO-FACTOR TF16)', () => {
	it('knows every two-factor event and labels it in plain words', () => {
		const labels = {
			'two-factor-turned-on': 'Turned on two-factor sign-in',
			'two-factor-turned-off': 'Turned off two-factor sign-in',
			'two-factor-reset': "Reset someone's two-factor sign-in",
			'recovery-code-used': 'Used a recovery code',
			'recovery-codes-replaced': 'Made new recovery codes',
			'code-confirmed': 'Typed an authenticator code again'
		} as const;
		for (const [kind, label] of Object.entries(labels)) {
			expect(isAuditKind(kind), kind).toBe(true);
			if (isAuditKind(kind)) {
				expect(activityLabel(kind)).toBe(label);
			}
		}
	});
});
