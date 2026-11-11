import { describe, expect, it } from 'vitest';
import { powerSourceLabel, type PowerReport } from './power.ts';

function reported(source: 'mains' | 'battery' | 'unknown', batteryPercent: number | null) {
	return {
		kind: 'reported',
		source,
		batteryPercent,
		keepAwake: 'off',
		inhibitor: { kind: 'none' }
	} satisfies PowerReport;
}

describe('powerSourceLabel (SPEC-MACHINE-DETAILS D13)', () => {
	it('D13: names the source and the battery level when there is one', () => {
		expect(powerSourceLabel(reported('mains', null))).toBe('Mains');
		expect(powerSourceLabel(reported('mains', 80))).toBe('Mains, battery 80%');
		expect(powerSourceLabel(reported('battery', 45))).toBe('Battery, 45%');
		expect(powerSourceLabel(reported('battery', null))).toBe('Battery');
		expect(powerSourceLabel(reported('unknown', null))).toBe('Unknown');
		expect(powerSourceLabel({ kind: 'unreported' })).toBe('Not reported by this agent');
	});
});
