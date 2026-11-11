import { describe, expect, it } from 'vitest';
import { updateWaitLine } from './update-wait.ts';

describe('the update countdown (SPEC-SERVER-UPDATES SU14)', () => {
	it('SU14: counts down the usual minute, then says it is taking longer', () => {
		expect(updateWaitLine(0)).toBe('About 60 seconds left');
		expect(updateWaitLine(18_200)).toBe('About 42 seconds left');
		expect(updateWaitLine(59_000)).toBe('About 1 second left');
		expect(updateWaitLine(60_000)).toBe('Taking a little longer than usual');
		expect(updateWaitLine(300_000)).toBe('Taking a little longer than usual');
		expect(updateWaitLine(-5)).toBe('About 60 seconds left');
	});
});
