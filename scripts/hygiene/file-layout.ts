import { extensionOf, runCommand } from './fs.ts';
import type { Reporter } from './report.ts';
import type { SourceFile } from './source-file.ts';

/** Extensions whose file and folder names must be kebab-case. */
const namingExtensions = new Set(['.ts', '.svelte', '.js', '.css', '.sql', '.md', '.json']);

const backupOrTempRegex = /(^|[-_.])(backup|temp|tmp|old)([-_.]|$)/i;
const kebabCaseRegex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** SvelteKit route files: `+page.svelte`, `+layout.server.ts`, `+server.ts`, `+error.svelte`. */
const ROUTE_FILE_REGEX = /^\+(page|layout|server|error)(@[\w-]*)?(\.server)?\.(svelte|ts|js)$/;

/** Framework files with fixed names (`src/app.d.ts`, `src/hooks.server.ts`, …). */
const FRAMEWORK_FILES = new Set([
	'src/app.d.ts',
	'src/app.html',
	'src/app.css',
	'src/hooks.server.ts',
	'src/hooks.client.ts',
	'src/hooks.ts',
	'src/service-worker/index.ts',
	'src/params.ts'
]);

/** The two global stylesheets (AGENTS.md §4). */
const GLOBAL_CSS_FILES: ReadonlySet<string> = new Set([
	'src/app.css',
	'src/lib/ui/design-tokens.css'
]);

/**
 * The folders src/lib/ is grouped into (AGENTS.md §2). It holds no modules of
 * its own; `assets/` holds static files SvelteKit imports (the favicon).
 */
const LIB_AREA_FOLDERS: ReadonlySet<string> = new Set([
	'assets',
	'domain',
	'prototype',
	'runes',
	'schemas',
	'server',
	'shell',
	'ui',
	'utils'
]);

/** A .ts or .svelte module directly in src/lib/, or in a folder that is not an area. */
function isLooseLibFile(relPath: string): boolean {
	if (!relPath.startsWith('src/lib/') || !/\.(ts|svelte)$/.test(relPath)) return false;
	const rest = relPath.slice('src/lib/'.length);
	const folder = rest.split('/')[0] ?? '';
	if (!rest.includes('/')) return true;
	return !LIB_AREA_FOLDERS.has(folder);
}

const sourceSoftLimit = 600;
const sourceHardLimit = 1000;

/** `[id]`, `[id=uuid]`, `[[optional]]`, `[...rest]`. */
function isRouteParameterSegment(segment: string): boolean {
	return /^\[{1,2}(\.\.\.)?[a-zA-Z_][\w]*(=[a-z][\w]*)?\]{1,2}$/.test(segment);
}

function isKebabCaseFilePath(relPath: string): boolean {
	if (FRAMEWORK_FILES.has(relPath)) return true;
	const segments = relPath.split('/').filter(Boolean);

	for (const [index, segment] of segments.entries()) {
		const isFile = index === segments.length - 1;
		if (segment === '.' || segment === '..') continue;
		if (isRouteParameterSegment(segment)) continue;

		// Route group folder, e.g. "(operations)": kebab-case inside.
		if (!isFile && segment.startsWith('(') && segment.endsWith(')')) {
			if (!kebabCaseRegex.test(segment.slice(1, -1))) return false;
			continue;
		}
		// RFC 8615 fixes this folder name (e.g. /.well-known/assetlinks.json).
		if (segment === '.well-known') continue;

		if (!isFile) {
			// Endpoint folders named after the file they serve: `manifest.json/+server.ts`.
			const served = /^(.+)\.(json|xml|txt|webmanifest)$/.exec(segment);
			if (!kebabCaseRegex.test(served ? (served[1] ?? '') : segment)) return false;
			continue;
		}
		if (ROUTE_FILE_REGEX.test(segment)) continue;

		const extension = extensionOf(segment);
		let stem = segment.slice(0, segment.length - extension.length);
		// Inner suffixes: `x.test.ts`, `x.svelte.ts`, `x.svelte.test.ts`, `x.server.ts`, `x.d.ts`, `x.json.ts`.
		for (;;) {
			const suffix = /\.(test|svelte|server|d|json)$/.exec(stem);
			if (!suffix) break;
			stem = stem.slice(0, suffix.index);
		}
		if (stem.includes('[') && stem.includes(']')) continue;
		if (!kebabCaseRegex.test(stem)) return false;
	}
	return true;
}

function isStyleModuleFile(relPath: string): boolean {
	return /-styles\.(ts|js|svelte\.ts)$/.test(relPath);
}

/**
 * Rules that only need a file's path, run for every file under src/
 * (including ones whose contents are not read).
 */
export function checkFilePath(relPath: string, { violation }: Reporter): void {
	const extension = extensionOf(relPath);
	if (namingExtensions.has(extension) && !isKebabCaseFilePath(relPath)) {
		violation('naming', relPath, 'File or folder name is not kebab-case');
	}

	if (extension === '.css' && !GLOBAL_CSS_FILES.has(relPath)) {
		violation(
			'css-placement',
			relPath,
			'Global CSS lives only in src/app.css and src/lib/ui/design-tokens.css; component styles go in the component’s scoped <style> block.'
		);
	}

	if (isStyleModuleFile(relPath)) {
		violation(
			'style-module-file',
			relPath,
			'Style module files are not allowed; write scoped <style> blocks with design-token variables'
		);
	}

	if (isLooseLibFile(relPath)) {
		violation(
			'lib-root-file-forbidden',
			relPath,
			'src/lib/ holds only its area folders: move the module into server/, domain/<area>/, schemas/<area>/, ui/, shell/, runes/, utils/ or prototype/.'
		);
	}

	if (relPath.startsWith('src/') && backupOrTempRegex.test(relPath)) {
		violation('artefact', relPath, 'Backup or temporary artefact detected inside src');
	}
}

/** AGENTS.md §7 file size budgets: warn above 600 lines, fail above 1000 (.svelte and .ts alike). */
export function checkFileSize(
	{ relPath, lineCount }: SourceFile,
	{ violation, warning }: Reporter
): void {
	if (lineCount > sourceHardLimit) {
		violation(
			'file-size',
			relPath,
			`Source file has ${lineCount} lines (hard limit: ${sourceHardLimit})`
		);
	} else if (lineCount > sourceSoftLimit) {
		warning(
			'file-size-soft',
			relPath,
			`Source file has ${lineCount} lines (soft limit: ${sourceSoftLimit})`
		);
	}
}

/**
 * Paths as git tracks them must be kebab-case too: a case-only rename git
 * did not pick up passes on a case-insensitive disk but breaks Linux builds.
 */
export async function verifyGitTrackedFileCasing(
	workspaceRoot: string,
	{ violation }: Reporter
): Promise<void> {
	const result = await runCommand('git', ['ls-files', 'src/'], workspaceRoot);
	if (!result.success) {
		violation('git-naming-case-failed', 'src/', `git ls-files failed: ${result.stderr.trim()}`);
		return;
	}
	for (const trackedPath of result.stdout.split('\n')) {
		const relPath = trackedPath.trim();
		if (!relPath || /(^|\/)migrations(\/|$)/.test(relPath)) continue;
		if (namingExtensions.has(extensionOf(relPath)) && !isKebabCaseFilePath(relPath)) {
			violation(
				'git-naming-case',
				relPath,
				'Git index path is not kebab-case (often a case-only rename git did not pick up). This breaks case-sensitive Linux builds; fix it with git mv.'
			);
		}
	}
}
