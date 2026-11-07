import { verifyClaudeSymlink } from '../../../../scripts/hygiene/project-files.ts';
import {
	RULE_INDEX_BEGIN,
	RULE_INDEX_END,
	renderRuleIndex,
	verifyRuleIndexCurrent
} from '../../../../scripts/hygiene/rule-index.ts';
import { inWorkspace, type RuleFixture, type WorkspaceFiles } from './harness.ts';

const claude = (files: WorkspaceFiles) => () =>
	inWorkspace(files, { git: false }, (root, reporter) => verifyClaudeSymlink(root, reporter));

/** An AGENTS.md with every numbered section the registry names, and the given rule index. */
function agentsMd(index: string): string {
	const sections = Array.from({ length: 16 }, (_, i) => `## ${String(i + 1)}. Section\n`);
	return `# Guidelines\n\n${sections.join('\n')}\n${index}\n`;
}

const ruleIndex = (index: string) => () =>
	inWorkspace({ 'AGENTS.md': agentsMd(index) }, { git: false }, (root, reporter) =>
		verifyRuleIndexCurrent(root, reporter)
	);

export const projectFileFixtures: readonly RuleFixture[] = [
	{
		rule: 'claude-symlink',
		bad: claude({ 'AGENTS.md': '# Rules', 'CLAUDE.md': '# Rules' }),
		good: claude({ 'AGENTS.md': '# Rules', 'CLAUDE.md': { symlinkTo: 'AGENTS.md' } })
	},
	{
		rule: 'hygiene-docs-current',
		bad: ruleIndex(`${RULE_INDEX_BEGIN}\n\n- \`naming\`: stale entry.\n\n${RULE_INDEX_END}`),
		good: ruleIndex(renderRuleIndex())
	}
];
