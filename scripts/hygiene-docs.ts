/**
 * Regenerates the hygiene rule index in AGENTS.md (§16) from the rule
 * registry, scripts/hygiene/rules.ts (`npm run hygiene:docs`). The hygiene
 * rule `hygiene-docs-current` fails until this has been run after a change
 * to the registry. Only the text between the generated markers changes.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENTS_FILE, replaceRuleIndex, rulesWithMissingSections } from './hygiene/rule-index.ts';

const path = join(process.cwd(), AGENTS_FILE);
const agents = await readFile(path, 'utf8');
const missing = rulesWithMissingSections(agents);
if (missing.length > 0) {
	throw new Error(
		`These rules name an AGENTS.md section with no heading: ${missing.join(', ')}. Fix their section in scripts/hygiene/rules.ts.`
	);
}
const updated = replaceRuleIndex(agents);
if (updated === agents) {
	console.log(`${AGENTS_FILE}: hygiene rule index already current.`);
} else {
	await writeFile(path, updated);
	console.log(`${AGENTS_FILE}: hygiene rule index regenerated.`);
}
