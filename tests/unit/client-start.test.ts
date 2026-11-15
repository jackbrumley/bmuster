import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import '../../src/hooks.client.ts';

describe('client start-up (SPEC-SIGN-IN S20)', () => {
	it('S20: turns off zod’s eval probe, so the strict CSP reports nothing', () => {
		expect(z.config().jitless).toBe(true);
	});
});
