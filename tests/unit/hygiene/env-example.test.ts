import { describe, expect, it } from 'vitest';
import { parseEnvExample } from '../../../scripts/hygiene/env-vars.ts';

describe('.env.example parsing (env-var-registered)', () => {
	it('lists set keys and commented-out optional keys, and skips prose comments', () => {
		const keys = parseEnvExample(
			[
				'# Path to the SQLite database file.',
				'DATABASE_PATH=./data/bmuster.db',
				'# 32 random bytes in base64: openssl rand -base64 32',
				'SECRETS_KEY=',
				'# Optional: the first admin.',
				'# BMUSTER_ADMIN_EMAIL=',
				'#BMUSTER_ADMIN_NAME=Administrator'
			].join('\n')
		);
		expect([...keys]).toEqual([
			'DATABASE_PATH',
			'SECRETS_KEY',
			'BMUSTER_ADMIN_EMAIL',
			'BMUSTER_ADMIN_NAME'
		]);
	});
});
