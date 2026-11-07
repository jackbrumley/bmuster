import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

describe('environment (S15)', () => {
	it('starts without CONSOLE_AUTH', async () => {
		vi.stubEnv('CONSOLE_AUTH', undefined);
		vi.resetModules();
		const { env } = await import('#lib/server/env.ts');
		expect(env.databasePath).toBe(':memory:');
		expect(Object.keys(env)).toEqual(['databasePath', 'secretsKey', 'releasesPath']);
	});

	it('no longer lists CONSOLE_AUTH for installers', () => {
		expect(readFileSync('.env.example', 'utf8')).not.toContain('CONSOLE_AUTH');
	});
});
