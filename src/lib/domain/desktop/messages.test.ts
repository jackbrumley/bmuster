import { describe, expect, it } from 'vitest';
import { desktopQualitiesFor } from './messages.ts';

describe('desktop qualities (SPEC-DESKTOP R10, version 2)', () => {
	it('R10: offers Extra high only to agents that know it', () => {
		expect(desktopQualitiesFor('0.4.17')).toContain('extra-high');
		expect(desktopQualitiesFor('0.5.0')).toContain('extra-high');
		expect(desktopQualitiesFor('0.4.16')).toEqual(['auto', 'low', 'medium', 'high']);
	});
});
