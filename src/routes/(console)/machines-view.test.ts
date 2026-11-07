import { describe, expect, it } from 'vitest';
import { defaultView } from './machines-view.ts';

describe('Machines view default', () => {
	it('shows cards up to 50 machines and the table above', () => {
		expect(defaultView(0)).toBe('cards');
		expect(defaultView(50)).toBe('cards');
		expect(defaultView(51)).toBe('table');
		expect(defaultView(500)).toBe('table');
	});
});
