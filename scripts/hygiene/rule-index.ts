import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Reporter } from './report.ts';
import { HYGIENE_RULES, RULE_IDS, type RuleId } from './rules.ts';

/**
 * The hygiene rule index in AGENTS.md §16 is generated from the rule
 * registry (scripts/hygiene/rules.ts) by `npm run hygiene:docs`, between the
 * markers below. `hygiene-docs-current` fails when it no longer matches.
 */
export const AGENTS_FILE = 'AGENTS.md';
export const RULE_INDEX_BEGIN = '<!-- BEGIN GENERATED: hygiene rule index -->';
export const RULE_INDEX_END = '<!-- END GENERATED: hygiene rule index -->';

const WIDTH = 80;

/** Words, keeping each `code span` whole so a line never breaks inside one. */
function words(text: string): string[] {
	const result: string[] = [];
	let pending = '';
	for (const word of text.split(' ').filter(Boolean)) {
		pending = pending === '' ? word : `${pending} ${word}`;
		if ((pending.match(/`/g) ?? []).length % 2 === 0) {
			result.push(pending);
			pending = '';
		}
	}
	if (pending !== '') result.push(pending);
	return result;
}

/** A list item wrapped at 80 columns, continuation lines indented two spaces. */
function listItem(text: string): string {
	const lines: string[] = [];
	let line = '';
	for (const word of words(text)) {
		if (line === '') {
			line = `- ${word}`;
		} else if (line.length + 1 + word.length > WIDTH) {
			lines.push(line);
			line = `  ${word}`;
		} else {
			line = `${line} ${word}`;
		}
	}
	lines.push(line);
	return lines.join('\n');
}

function ruleEntry(id: RuleId): string {
	const rule = HYGIENE_RULES[id];
	return listItem(
		`\`${id}\` (${rule.severity}, §${rule.section}): ${rule.why} **Fix:** ${rule.fix}`
	);
}

/** The generated text between the markers (markers included). */
export function renderRuleIndex(): string {
	const ids = [...RULE_IDS].sort((a, b) => a.localeCompare(b));
	return [RULE_INDEX_BEGIN, '', ...ids.map(ruleEntry), '', RULE_INDEX_END].join('\n');
}

/** AGENTS.md with the generated section replaced; throws when the markers are missing. */
export function replaceRuleIndex(agents: string): string {
	const start = agents.indexOf(RULE_INDEX_BEGIN);
	const end = agents.indexOf(RULE_INDEX_END);
	if (start === -1 || end === -1 || end < start) {
		throw new Error(
			`${AGENTS_FILE} has no generated hygiene rule index markers (${RULE_INDEX_BEGIN} … ${RULE_INDEX_END}).`
		);
	}
	return agents.slice(0, start) + renderRuleIndex() + agents.slice(end + RULE_INDEX_END.length);
}

/** Whether AGENTS.md has a heading for a section: `3` is `## 3.`, `10.A` is `### A.` under `## 10.`. */
function hasSection(agents: string, section: string): boolean {
	const [chapter, part] = section.split('.');
	const lines = agents.split('\n');
	const start = lines.findIndex((line) => line.startsWith(`## ${chapter ?? ''}. `));
	if (start === -1) return false;
	if (part === undefined) return true;
	for (const line of lines.slice(start + 1)) {
		if (line.startsWith('## ')) return false;
		if (line.startsWith(`### ${part}. `) || line.startsWith(`### ${section} `)) return true;
	}
	return false;
}

/** Registered rules whose AGENTS.md section has no heading. */
export function rulesWithMissingSections(agents: string): RuleId[] {
	return RULE_IDS.filter((id) => !hasSection(agents, HYGIENE_RULES[id].section));
}

/** `hygiene-docs-current`: the rule index in AGENTS.md matches the registry. */
export async function verifyRuleIndexCurrent(
	workspaceRoot: string,
	{ violation }: Reporter
): Promise<void> {
	let agents: string;
	try {
		agents = await readFile(join(workspaceRoot, AGENTS_FILE), 'utf8');
	} catch {
		violation('hygiene-docs-current', AGENTS_FILE, `${AGENTS_FILE} is missing.`);
		return;
	}
	let expected: string;
	try {
		expected = replaceRuleIndex(agents);
	} catch (error) {
		violation(
			'hygiene-docs-current',
			AGENTS_FILE,
			error instanceof Error ? error.message : String(error)
		);
		return;
	}
	if (expected !== agents) {
		violation(
			'hygiene-docs-current',
			AGENTS_FILE,
			'The hygiene rule index is out of date with scripts/hygiene/rules.ts. Run: npm run hygiene:docs'
		);
	}
	for (const id of rulesWithMissingSections(agents)) {
		violation(
			'hygiene-docs-current',
			'scripts/hygiene/rules.ts',
			`Rule \`${id}\` names AGENTS.md §${HYGIENE_RULES[id].section}, which has no heading.`
		);
	}
}
