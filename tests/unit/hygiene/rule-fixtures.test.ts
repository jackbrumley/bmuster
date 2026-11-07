/**
 * Every hygiene rule is provably alive: for each rule registered in
 * scripts/hygiene/rules.ts, a minimal bad sample must make it fire and a
 * close good sample must not. A rule with no fixture fails the meta-test,
 * so a rule whose pattern silently stopped matching cannot pass unnoticed.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { HYGIENE_RULES, RULE_IDS } from '../../../scripts/hygiene/rules.ts';
import {
	AGENTS_FILE,
	replaceRuleIndex,
	rulesWithMissingSections
} from '../../../scripts/hygiene/rule-index.ts';
import type { RuleFixture } from './fixtures/harness.ts';
import { codeStandardsFixtures } from './fixtures/code-standards.ts';
import { componentFixtures } from './fixtures/components.ts';
import { fileLayoutFixtures } from './fixtures/file-layout.ts';
import { projectFileFixtures } from './fixtures/project-files.ts';
import { projectRuleFixtures } from './fixtures/project-rules.ts';
import { stylingFixtures } from './fixtures/styling.ts';

const FIXTURES: Readonly<Record<string, readonly RuleFixture[]>> = {
	'file-layout': fileLayoutFixtures,
	'code-standards': codeStandardsFixtures,
	styling: stylingFixtures,
	components: componentFixtures,
	'project-files': projectFileFixtures,
	'project-rules': projectRuleFixtures
};

const ALL = Object.values(FIXTURES).flat();

for (const [group, fixtures] of Object.entries(FIXTURES)) {
	describe(`hygiene fixtures: ${group}`, () => {
		fixtures.forEach((fixture, index) => {
			test(`${fixture.rule} (#${index + 1}) fires on the bad sample`, async () => {
				expect(await fixture.bad()).toContain(fixture.rule);
			});
			test(`${fixture.rule} (#${index + 1}) stays quiet on the good sample`, async () => {
				expect(await fixture.good()).not.toContain(fixture.rule);
			});
		});
	});
}

describe('hygiene rule registry', () => {
	test('every registered rule has a fixture', () => {
		const covered = new Set(ALL.map((fixture) => fixture.rule));
		expect(RULE_IDS.filter((id) => !covered.has(id))).toEqual([]);
	});

	test('every rule names an AGENTS.md section that exists', async () => {
		const agents = await readFile(AGENTS_FILE, 'utf8');
		expect(rulesWithMissingSections(agents)).toEqual([]);
	});

	test('the AGENTS.md rule index is current', async () => {
		const agents = await readFile(AGENTS_FILE, 'utf8');
		expect(replaceRuleIndex(agents) === agents).toBe(true);
	});

	test('every rule says why and how to fix it in one line', () => {
		for (const id of RULE_IDS) {
			const { why, fix } = HYGIENE_RULES[id];
			expect(why.trim(), id).not.toBe('');
			expect(fix.trim(), id).not.toBe('');
			expect(`${why}${fix}`, id).not.toContain('\n');
		}
	});
});
