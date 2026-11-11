import { describe, expect, it } from 'vitest';
import { formatDuration } from './format.ts';

describe('formatDuration (SPEC-MACHINE-DETAILS D12)', () => {
	it('D12: counts whole minutes, hours and days, leaving out a zero remainder', () => {
		expect(formatDuration(0)).toBe('under a minute');
		expect(formatDuration(59)).toBe('under a minute');
		expect(formatDuration(12 * 60 + 59)).toBe('12 min');
		expect(formatDuration(3600)).toBe('1 h');
		expect(formatDuration(5 * 3600 + 12 * 60)).toBe('5 h 12 min');
		expect(formatDuration(86_400)).toBe('1 day');
		expect(formatDuration(86_400 + 3600)).toBe('1 day 1 h');
		expect(formatDuration(3 * 86_400 + 4 * 3600 + 59 * 60)).toBe('3 days 4 h');
	});
});
