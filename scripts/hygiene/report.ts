import { rulePointer, type RuleId, type RuleIdOf, type Severity } from './rules.ts';

/**
 * Records one finding of a hygiene rule against a file. Only ids registered
 * in scripts/hygiene/rules.ts with the matching severity are accepted.
 */
export type Report<S extends Severity = 'violation'> = (
	rule: RuleIdOf<S>,
	path: string,
	details: string
) => void;

/** Where rules send findings: violations fail the run, warnings do not. */
export interface Reporter {
	readonly violation: Report;
	readonly warning: Report<'warning'>;
}

interface Finding {
	readonly rule: RuleId;
	readonly path: string;
	readonly details: string;
}

const violations: Finding[] = [];
const warnings: Finding[] = [];

export const reporter: Reporter = {
	violation(rule, path, details) {
		violations.push({ rule, path, details });
	},
	warning(rule, path, details) {
		warnings.push({ rule, path, details });
	}
};

function countByRule(findings: readonly Finding[]): string[] {
	const counts = new Map<string, number>();
	for (const { rule } of findings) counts.set(rule, (counts.get(rule) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([rule, count]) => `  ${String(count).padStart(5)}  ${rule}`);
}

/** One printed finding, ending with the AGENTS.md section its rule enforces. */
function formatFinding({ rule, path, details }: Finding): string {
	return `- [${rule}] ${path}: ${details} (${rulePointer(rule)})`;
}

/** Prints every warning and violation, then a count per rule; exit code 1 when anything failed. */
export function printSummaryAndExit(): void {
	if (warnings.length > 0) {
		console.warn(`Hygiene warnings (${warnings.length}):`);
		for (const warning of warnings) {
			console.warn(formatFinding(warning));
		}
	}

	if (violations.length > 0) {
		console.error(`Hygiene check failed with ${violations.length} issue(s):`);
		for (const violation of violations) {
			console.error(formatFinding(violation));
		}
	}

	if (warnings.length > 0) {
		console.warn(`\nWarnings by rule:\n${countByRule(warnings).join('\n')}`);
	}
	if (violations.length === 0) {
		console.log('Hygiene check passed.');
		return;
	}
	console.error('Rule index: AGENTS.md §16, "Hygiene" (why and how to fix each rule).');
	console.error(`\nViolations by rule:\n${countByRule(violations).join('\n')}`);
	process.exitCode = 1;
}
