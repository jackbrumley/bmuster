/**
 * Hygiene check (`npm run hygiene`, `node scripts/hygiene.ts`): the
 * structural, styling and safety rules from AGENTS.md that lint cannot
 * express (§16). Each rule lives in a module under scripts/hygiene/; this
 * file loads src/ once (parsing `.svelte` components with svelte/compiler),
 * runs the per-file rules, then the project-wide checks, and prints the
 * result with a count per rule.
 */
import { pathExists } from './hygiene/fs.ts';
import { printSummaryAndExit, reporter } from './hygiene/report.ts';
import { checkSvelteParses, loadSourceTree, type SourceFile } from './hygiene/source-file.ts';
import { checkFilePath, checkFileSize, verifyGitTrackedFileCasing } from './hygiene/file-layout.ts';
import { checkCodeStandards } from './hygiene/code-standards.ts';
import { checkStyling } from './hygiene/styling.ts';
import { checkRawControls } from './hygiene/raw-controls.ts';
import { checkDestructiveConfirmation } from './hygiene/destructive-confirmation.ts';
import { checkServerImports } from './hygiene/server-boundary.ts';
import { checkUiComponents } from './hygiene/ui-components.ts';
import { GLOBAL_STYLESHEETS, verifyInputFontSize } from './hygiene/input-font-size.ts';
import { radiusRoles, RADIUS_VARIABLES_FILE, verifyBorderRadius } from './hygiene/border-radius.ts';
import { verifyPageFrames } from './hygiene/page-frames.ts';
import { verifyClientFetch } from './hygiene/client-fetch.ts';
import { listedEnvVars, verifyEnvVars } from './hygiene/env-vars.ts';
import { verifyNoDoubleCasts } from './hygiene/double-cast.ts';
import { verifyClaudeSymlink } from './hygiene/project-files.ts';
import { verifyRuleIndexCurrent } from './hygiene/rule-index.ts';

const workspaceRoot = process.cwd();

/** Runs every per-file rule over src/. */
function checkSourceFiles(paths: readonly string[], files: readonly SourceFile[]): void {
	for (const relPath of paths) checkFilePath(relPath, reporter);

	for (const file of files) {
		if (!checkSvelteParses(file, reporter)) continue;
		checkCodeStandards(file, reporter);
		checkStyling(file, reporter);
		checkServerImports(file, reporter.violation);
		checkUiComponents(file, reporter);
		checkRawControls(file, reporter.violation);
		checkDestructiveConfirmation(file.relPath, file.content, reporter.violation);
		checkFileSize(file, reporter);
	}
}

async function run(): Promise<void> {
	if (!(await pathExists(`${workspaceRoot}/src`))) {
		throw new Error('No src/ directory: run hygiene from the repository root.');
	}

	const { paths, files } = await loadSourceTree(workspaceRoot);
	const parsable = files.filter((f) => !f.isSvelte || f.svelte() !== null);
	const byPath = new Map(files.map((f) => [f.relPath, f]));

	checkSourceFiles(paths, files);

	// The global stylesheets custom properties resolve through.
	const globalStylesheets = GLOBAL_STYLESHEETS.map((path) => byPath.get(path)).filter(
		(sheet): sheet is SourceFile => sheet !== undefined
	);
	verifyInputFontSize(parsable, globalStylesheets, reporter.violation);
	verifyBorderRadius(parsable, radiusRoles(byPath.get(RADIUS_VARIABLES_FILE)), reporter.violation);
	verifyPageFrames(parsable, reporter.violation);
	verifyClientFetch(parsable, reporter.violation);
	verifyEnvVars(parsable, await listedEnvVars(workspaceRoot), reporter.violation);

	// No casts through unknown in application code, tests or scripts
	await verifyNoDoubleCasts(workspaceRoot, reporter.violation);

	// Git index paths are kebab-case (case-only renames break Linux builds)
	await verifyGitTrackedFileCasing(workspaceRoot, reporter);

	// CLAUDE.md is a symbolic link to AGENTS.md
	await verifyClaudeSymlink(workspaceRoot, reporter);

	// The AGENTS.md hygiene rule index matches the rule registry
	await verifyRuleIndexCurrent(workspaceRoot, reporter);

	printSummaryAndExit();
}

await run();
