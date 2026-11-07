import type { AST } from 'svelte/compiler';
import type { Report } from './report.ts';
import { isTestFile, type SourceFile } from './source-file.ts';
import {
	attributeText,
	findAttribute,
	stylesheetDeclarations,
	type CssDeclaration,
	allDeclarations
} from './template.ts';
import { splitValue } from './css-values.ts';

const INPUT_FONT_SIZE_RULE = 'input-font-size-ios-zoom';

/**
 * iPhones zoom the page when someone taps into a text box whose text is
 * smaller than 16px: text-like inputs, textareas, selects, contenteditable
 * elements and the hidden textareas libraries type through (xterm.js).
 * BMuster is designed at phone width first (AGENTS.md §4), so that zoom only
 * crops the layout. Every text box uses 16px (1rem) text or more.
 *
 * Checked here:
 * - src/app.css gives `input`, `textarea`, `select` and `[contenteditable]`
 *   16px text, so a text box no rule sizes never falls back to the browser's
 *   smaller default or inherits a small size from its parent;
 * - `style="font-size: …"` / `style:font-size` on raw text boxes;
 * - rules in component `<style>` blocks and src/app.css whose subject is a
 *   text box: `input`, `textarea`, `select`, `[contenteditable]`, a class the
 *   component puts on one of its text boxes, or a library's text box class
 *   (`THIRD_PARTY_FIELD_CLASSES`), also inside `:global(…)`;
 * - `font: inherit` (or another keyword) on a text box, which drops the
 *   16px base for the parent's size, unless the rule then sets `font-size`;
 * - `.style.fontSize` (a literal) on fields made with `document.createElement`;
 * - the root font size `rem` is based on.
 *
 * `var(--…)` values are resolved through the custom properties declared in
 * the global stylesheets and the component itself, so `var(--text-base)` and
 * the larger tokens pass and `var(--text-sm)` fails. A size that cannot be
 * worked out (`em`, `%`, `inherit`, `unset`, `calc()`/`clamp()`/`min()`, an
 * unknown variable, a `{prop}`) fails too: `inherit` takes the size of
 * whatever the box sits in, which the check cannot see, and `em` or a
 * function can go under 16px. Write a token that resolves to px or rem.
 */
const MIN_FONT_SIZE_PX = 16;
const ROOT_FONT_SIZE_PX = 16;

const RAW_FIELDS = new Set(['input', 'textarea', 'select']);

/** Why every message fires, said in each one. */
const WHY = `iOS zooms the page when a text box under ${MIN_FONT_SIZE_PX}px is focused`;

/**
 * Classes of the text boxes libraries create themselves, so they never appear
 * in our markup: xterm.js types through `.xterm-helper-textarea`, which
 * otherwise inherits the terminal's 12–14px font.
 */
const THIRD_PARTY_FIELD_CLASSES: ReadonlySet<string> = new Set(['xterm-helper-textarea']);

/** The stylesheet that must give every raw text box its 16px base size. */
const BASE_STYLESHEET = 'src/app.css';

/** Selectors the base rule in src/app.css must cover. */
const BASE_SELECTORS: readonly string[] = ['input', 'textarea', 'select', '[contenteditable]'];

/** `font` shorthand values that set the size from somewhere the check cannot see. */
const FONT_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

/** Input types that never show a keyboard, so never zoom. */
const NON_TEXT_INPUT_TYPES = new Set([
	'checkbox',
	'radio',
	'range',
	'color',
	'file',
	'hidden',
	'submit',
	'button',
	'reset',
	'image'
]);

/** Stylesheets whose `:root` custom properties every component can use. */
export const GLOBAL_STYLESHEETS: readonly string[] = [
	'src/lib/ui/design-tokens.css',
	'src/app.css'
];

type Variables = ReadonlyMap<string, string>;

function fontSizeInPx(value: string): number | null {
	const match = /^(\d*\.?\d+)(px|rem)$/.exec(value.trim());
	if (!match) return null;
	const amount = Number(match[1]);
	return match[2] === 'rem' ? amount * ROOT_FONT_SIZE_PX : amount;
}

/** Follows `var(--x, fallback)` through the known custom properties. */
function resolveValue(value: string, variables: Variables, depth = 0): string | null {
	const trimmed = value.trim();
	const variable = /^var\(\s*(--[\w-]+)\s*(?:,([\s\S]*))?\)$/.exec(trimmed);
	if (!variable) return trimmed;
	if (depth > 5) return null;
	const known = variables.get(variable[1] ?? '');
	if (known !== undefined) return resolveValue(known, variables, depth + 1);
	const fallback = variable[2];
	return fallback === undefined ? null : resolveValue(fallback, variables, depth + 1);
}

function describeProblem(value: string, variables: Variables): string | null {
	const resolved = resolveValue(value, variables);
	const shown =
		resolved !== null && resolved !== value.trim() ? `${value.trim()} = ${resolved}` : value.trim();
	const px = resolved === null ? null : fontSizeInPx(resolved);
	if (px === null) {
		return `font size \`${shown}\` cannot be checked; ${WHY}, so use a token that resolves to at least ${MIN_FONT_SIZE_PX}px (1rem), e.g. \`var(--text-base)\``;
	}
	if (px < MIN_FONT_SIZE_PX) {
		return `font size \`${shown}\` (${px}px) is under ${MIN_FONT_SIZE_PX}px; ${WHY}, so use \`var(--text-base)\` or larger`;
	}
	return null;
}

/** The size part of a `font` shorthand, e.g. `600 var(--text-sm)/1.2 sans-serif`. */
function shorthandSize(value: string): string | null {
	if (FONT_KEYWORDS.has(value.trim().toLowerCase())) return value.trim();
	for (const token of splitValue(value, /\s/)) {
		const size = token.split('/')[0] ?? '';
		if (
			size.startsWith('var(') ||
			/^[\d.]+(px|rem|em|%)$/.test(size) ||
			/(small|medium|large)$/.test(size)
		) {
			return size;
		}
	}
	return null;
}

function declaredSize(declaration: CssDeclaration): string | null {
	const property = declaration.property.trim().toLowerCase();
	if (property === 'font-size') return declaration.value;
	if (property === 'font') return shorthandSize(declaration.value);
	return null;
}

/** Custom properties declared at the root of a stylesheet (or anywhere in a component). */
function declaredVariables(file: SourceFile, rootOnly: boolean): Map<string, string> {
	const variables = new Map<string, string>();
	for (const declaration of stylesheetDeclarations(file)) {
		if (!declaration.property.startsWith('--')) continue;
		if (rootOnly && !/^(:root|html)$/.test((declaration.selector ?? '').trim())) continue;
		if (declaration.atRules.length > 0 && rootOnly) continue;
		if (!variables.has(declaration.property))
			variables.set(declaration.property, declaration.value);
	}
	return variables;
}

/** Strips `:global(…)` wrappers so scoped and global selectors read the same. */
function unwrapGlobal(selector: string): string {
	return selector
		.replace(/:global\(([^()]*(?:\([^()]*\))?[^()]*)\)/g, '$1')
		.replace(/:global\s*/g, '');
}

function selectorSubject(selector: string): string {
	const compounds = unwrapGlobal(selector)
		.trim()
		.split(/\s*[\s>+~]\s*/);
	return compounds[compounds.length - 1] ?? '';
}

function selectsField(selector: string, fieldClasses: ReadonlySet<string>): boolean {
	if (selector.includes('::')) return false;
	const subject = selectorSubject(selector);
	if (/\[contenteditable/i.test(subject)) return true;
	for (const match of subject.matchAll(/\.([\w-]+)/g)) {
		const name = match[1] ?? '';
		if (fieldClasses.has(name) || THIRD_PARTY_FIELD_CLASSES.has(name)) return true;
	}
	const element = /^(input|textarea|select)\b/.exec(subject);
	if (!element) return false;
	if (element[1] !== 'input') return true;
	const types = [...subject.matchAll(/\[type=["']?([\w-]+)["']?\]/g)].map((m) => m[1] ?? '');
	return types.length === 0 || types.some((t) => !NON_TEXT_INPUT_TYPES.has(t));
}

function isRootSelector(selector: string): boolean {
	return /^(html|:root)$/.test(unwrapGlobal(selector).trim());
}

/** The label of a template element that is a field, or null. */
function fieldLabel(element: AST.ElementLike): string | null {
	if (element.type !== 'RegularElement') return null;
	if (RAW_FIELDS.has(element.name)) {
		if (element.name === 'input') {
			const type = findAttribute(element, 'type');
			const literal = type ? attributeText(type) : null;
			if (literal !== null && NON_TEXT_INPUT_TYPES.has(literal)) return null;
		}
		return `<${element.name}>`;
	}
	const editable = findAttribute(element, 'contenteditable');
	if (editable && attributeText(editable) !== 'false') return `contenteditable <${element.name}>`;
	return null;
}

/** Classes a component puts on its own fields (`class="…"` and `class:x`). */
function fieldClassNames(fields: readonly AST.ElementLike[]): Set<string> {
	const classes = new Set<string>();
	for (const field of fields) {
		for (const attribute of field.attributes) {
			if (attribute.type === 'ClassDirective') classes.add(attribute.name);
			if (attribute.type === 'Attribute' && attribute.name === 'class') {
				for (const name of (attributeText(attribute) ?? '').split(/\s+/)) {
					if (name) classes.add(name);
				}
			}
		}
	}
	return classes;
}

/** Fields in a component or stylesheet whose font size would make an iPhone zoom. */
function scanFontSizes(file: SourceFile, globals: Variables): string[] {
	const issues: string[] = [];
	const variables = new Map([...globals, ...declaredVariables(file, false)]);
	const document = file.svelte();
	const fields = (document?.elements ?? []).filter((element) => fieldLabel(element) !== null);
	const fieldClasses = fieldClassNames(fields.filter((f) => f.type === 'RegularElement'));

	const declarations = allDeclarations(file);
	for (const declaration of declarations) {
		const size = declaredSize(declaration);
		if (size === null) continue;
		const where = `Line ${declaration.line}:`;
		if (declaration.element !== null) {
			const label = fieldLabel(declaration.element);
			if (label === null) continue;
			const problem = declaration.dynamic
				? `font size \`${size}\` is computed and cannot be checked; ${WHY}, so use a token that resolves to at least ${MIN_FONT_SIZE_PX}px`
				: describeProblem(size, variables);
			if (problem !== null && problem !== '') issues.push(`${where} ${label} ${problem}.`);
			continue;
		}
		const selectors = splitValue(declaration.selector ?? '', /,/).map((s) => s.trim());
		if (
			selectors.some(isRootSelector) &&
			declaration.property.trim().toLowerCase() === 'font-size'
		) {
			const resolved = resolveValue(size, variables);
			if (
				resolved !== '100%' &&
				(resolved === null || fontSizeInPx(resolved) !== ROOT_FONT_SIZE_PX)
			) {
				issues.push(
					`${where} root font size \`${size}\` changes what 1rem means, so rem-sized text boxes can drop under ${MIN_FONT_SIZE_PX}px; ${WHY}, so leave it at 100%.`
				);
			}
			continue;
		}
		if (!selectors.some((s) => selectsField(s, fieldClasses))) continue;
		if (FONT_KEYWORDS.has(size.trim().toLowerCase()) && sizedLater(declaration, declarations))
			continue;
		const problem = describeProblem(size, variables);
		if (problem !== null && problem !== '')
			issues.push(`${where} \`${(declaration.selector ?? '').replace(/\s+/g, ' ')}\` ${problem}.`);
	}

	const script = file.scriptText();
	if (script !== null) issues.push(...scanCreatedFields(script, variables));
	return issues;
}

/**
 * Whether a later `font-size` in the same rule (same selector and at-rules)
 * replaces the size a `font: inherit` shorthand just reset.
 */
function sizedLater(shorthand: CssDeclaration, declarations: readonly CssDeclaration[]): boolean {
	return declarations.some(
		(other) =>
			other.property.trim().toLowerCase() === 'font-size' &&
			other.selector === shorthand.selector &&
			other.atRules.join('/') === shorthand.atRules.join('/') &&
			other.line >= shorthand.line &&
			other !== shorthand
	);
}

/**
 * src/app.css must size `input`, `textarea`, `select` and `[contenteditable]`
 * at 16px or more outside any at-rule; without it a text box no component
 * rule sizes takes the browser default (13.33px) or its parent's size.
 */
function scanBaseRule(sheet: SourceFile, variables: Variables): string[] {
	const covered = new Set<string>();
	for (const declaration of stylesheetDeclarations(sheet)) {
		if (declaration.atRules.length > 0) continue;
		const size = declaredSize(declaration);
		if (size === null || describeProblem(size, variables) !== null) continue;
		for (const selector of splitValue(declaration.selector ?? '', /,/)) {
			const bare = selector.trim();
			if (BASE_SELECTORS.includes(bare)) covered.add(bare);
		}
	}
	const missing = BASE_SELECTORS.filter((selector) => !covered.has(selector));
	if (missing.length === 0) return [];
	return [
		`no rule gives \`${missing.join('`, `')}\` a font size of at least ${MIN_FONT_SIZE_PX}px, so a text box no component sizes takes the browser's smaller default or its parent's size; ${WHY}. Add \`${BASE_SELECTORS.join(', ')} { font-size: var(--text-base); }\`.`
	];
}

/** `.style.fontSize = …` on fields made with `document.createElement`. */
function scanCreatedFields(script: string, variables: Variables): string[] {
	const issues: string[] = [];
	const created =
		/(?:const|let)\s+(\w+)\s*=\s*document\.createElement\(\s*["'](input|textarea|select)["']\s*\)/g;
	for (const match of script.matchAll(created)) {
		const [, variable = '', element = ''] = match;
		const typeSet = new RegExp(`\\b${variable}\\.type\\s*=\\s*["'](\\w+)["']`).exec(script);
		if (typeSet && NON_TEXT_INPUT_TYPES.has(typeSet[1] ?? '')) continue;
		const assignment = new RegExp(`\\b${variable}\\.style\\.fontSize\\s*=\\s*([^;\\n]+)`, 'g');
		for (const set of script.matchAll(assignment)) {
			const line = script.slice(0, set.index).split('\n').length;
			const raw = (set[1] ?? '').trim();
			const literal = /^["'`]([^"'`$]*)["'`]$/.exec(raw);
			const value = literal ? (literal[1] ?? '') : null;
			const problem =
				value !== null
					? describeProblem(value, variables)
					: `font size \`${raw}\` cannot be checked; ${WHY}, so assign a literal of at least ${MIN_FONT_SIZE_PX}px`;
			if (problem !== null && problem !== '') {
				issues.push(`Line ${line}: created <${element}> ${problem}.`);
			}
		}
	}
	return issues;
}

export function verifyInputFontSize(
	files: readonly SourceFile[],
	globalStylesheets: readonly SourceFile[],
	report: Report
): void {
	const globals = new Map<string, string>();
	for (const sheet of globalStylesheets) {
		for (const [name, value] of declaredVariables(sheet, true)) {
			if (!globals.has(name)) globals.set(name, value);
		}
	}
	const base = globalStylesheets.find((sheet) => sheet.relPath === BASE_STYLESHEET);
	if (base !== undefined) {
		for (const issue of scanBaseRule(base, globals))
			report(INPUT_FONT_SIZE_RULE, base.relPath, issue);
	}
	for (const file of files) {
		if (isTestFile(file.relPath)) continue;
		if (!file.isSvelte && !file.isCss && !file.isScript) continue;
		for (const issue of scanFontSizes(file, globals)) {
			report(INPUT_FONT_SIZE_RULE, file.relPath, issue);
		}
	}
}
