import { describe, expect, it } from 'vitest';
import { compareAgentVersions, isAgentVersion, isOlderAgent } from './agent-version.ts';

describe('agent versions (SPEC-AGENT-UPDATES)', () => {
	it('orders versions like the agent does, development builds before their release', () => {
		const ordered = [
			'0.1.0-dev.20261107153000',
			'0.1.0-dev.20261107153001',
			'0.1.0',
			'0.1.1',
			'0.2.0-alpha',
			'0.2.0-alpha.1',
			'0.2.0-alpha.beta',
			'0.2.0-beta.2',
			'0.2.0-beta.11',
			'0.2.0',
			'1.0.0',
			'10.0.0'
		];
		for (let index = 1; index < ordered.length; index += 1) {
			const older = ordered[index - 1] ?? '';
			const newer = ordered[index] ?? '';
			expect(compareAgentVersions(older, newer), `${older} < ${newer}`).toBe(-1);
			expect(compareAgentVersions(newer, older)).toBe(1);
		}
		expect(compareAgentVersions('1.2.3', '1.2.3')).toBe(0);
	});

	it('refuses anything that is not a plain version, so a version is never a path', () => {
		for (const bad of [
			'',
			'1.2',
			'1.2.3.4',
			'01.2.3',
			'1.2.3-',
			'1.2.3+build',
			'1.2.3-01',
			'../1.2.3',
			'1.2.3/..',
			'v1.2.3'
		]) {
			expect(isAgentVersion(bad), bad).toBe(false);
		}
		expect(isAgentVersion('0.1.0-dev.20261107153000')).toBe(true);
	});

	it('treats an unreadable reported version as older', () => {
		expect(isOlderAgent('garbage', '0.1.0')).toBe(true);
		expect(isOlderAgent('0.1.0', '0.1.0')).toBe(false);
		expect(isOlderAgent('0.1.0-dev.1', '0.1.0')).toBe(true);
	});
});
