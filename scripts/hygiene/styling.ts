import { checkCssValue } from './css-values.ts';
import type { Reporter } from './report.ts';
import { isTestFile, isUiSourceFile, type SourceFile } from './source-file.ts';
import { allDeclarations } from './template.ts';

/**
 * Styling (AGENTS.md §4, §5): components style themselves in scoped `<style>`
 * blocks, and every visual value comes from a design-token custom property,
 * `var(--…)`.
 *
 * - `style-token-required`: a value in a `<style>` block, `style="…"` or
 *   `style:` directive that is not built from `var(--…)` (see css-values.ts
 *   for what counts as a non-visual value).
 * - `hardcoded-color-forbidden`: hex, `rgb()`/`hsl()` or named colours
 *   outside the token sources, in styles and in script strings.
 * - `important-forbidden`, `raw-emoji-forbidden`.
 */

/**
 * The only files that may hold raw colour values: the tokens (each a
 * `light-dark()` pair) and the global stylesheet.
 */
const COLOUR_SOURCE_FILES: ReadonlySet<string> = new Set([
	'src/lib/ui/design-tokens.css',
	'src/app.css'
]);

function mayHoldRawColours(relPath: string): boolean {
	return COLOUR_SOURCE_FILES.has(relPath) || isTestFile(relPath);
}

const rawEmojiRegex =
	/[\uD83C-\uDBFF][\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDFFF]|[☀-➿]/;

export function checkStyling(file: SourceFile, { violation }: Reporter): void {
	const { relPath, content } = file;

	if (content.includes('!important')) {
		violation(
			'important-forbidden',
			relPath,
			'!important is forbidden in styles; fix the specificity or structure instead'
		);
	}

	if (isUiSourceFile(relPath) && rawEmojiRegex.test(content)) {
		violation(
			'raw-emoji-forbidden',
			relPath,
			'Raw emoji are forbidden (AGENTS.md §5). Use Tabler icons from @tabler/icons-svelte-runes instead.'
		);
	}

	checkDeclarations(file, violation);
	// Script strings are checked where they style UI: components, routes, shared UI and state.
	const script = file.scriptText();
	if (script !== null && isUiSourceFile(relPath) && !mayHoldRawColours(relPath)) {
		checkScriptColours(file, script, violation);
	}
}

/** Style blocks, style attributes and directives in components, and global CSS. */
function checkDeclarations(file: SourceFile, violation: Reporter['violation']): void {
	const isTokenSource = COLOUR_SOURCE_FILES.has(file.relPath);
	for (const declaration of allDeclarations(file)) {
		// The global stylesheets define the tokens themselves.
		if (isTokenSource && declaration.property.startsWith('--')) continue;
		for (const problem of checkCssValue(declaration.property, declaration.value)) {
			if (problem.kind === 'colour') {
				if (isTokenSource) continue;
				violation(
					'hardcoded-color-forbidden',
					file.relPath,
					`Line ${declaration.line}: ${declaration.property}: ${declaration.value} — colour \`${problem.text}\` must come from a design-token variable (var(--…)).`
				);
			} else if (!isTokenSource) {
				violation(
					'style-token-required',
					file.relPath,
					`Line ${declaration.line}: ${declaration.property}: ${declaration.value} — \`${problem.text}\` is not a design token; use var(--…) (or 0, %, fr, auto, a keyword).`
				);
			}
		}
	}
}

const hexColourRegex = /["'`]#[0-9a-fA-F]{3,8}["'`]/;
const functionColourRegex = /["'`]\s*(?:rgba?|hsla?|oklch|light-dark)\s*\([^)]*\)/i;
const namedColourRegex =
	/\b(?:backgroundColor|borderColor|color|fill|stroke|background)\s*:\s*["'](?:white|black|red|green|blue|yellow)["']/i;

/** Colours written as strings in script code (style values, canvas, charts). */
function checkScriptColours(
	file: SourceFile,
	script: string,
	violation: Reporter['violation']
): void {
	script.split('\n').forEach((line, index) => {
		const trimmed = line.trim();
		if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return;
		if (
			hexColourRegex.test(line) ||
			functionColourRegex.test(line) ||
			namedColourRegex.test(line)
		) {
			violation(
				'hardcoded-color-forbidden',
				file.relPath,
				`Line ${index + 1}: "${trimmed}": hardcoded colour. All colours come from design-token variables (var(--…)).`
			);
		}
	});
}
