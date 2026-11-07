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
 * iPhones zoom the page when someone taps into a field whose text is
 * smaller than 16px: inputs, textareas, selects and contenteditable
 * elements. BMuster is designed at phone width first (AGENTS.md §4), so that
 * zoom only crops the layout. Every field uses 16px (1rem) text or more.
 *
 * Checked here:
 * - `style="font-size: …"` / `style:font-size` on raw fields;
 * - rules in component `<style>` blocks and src/app.css whose subject is a
 *   field: `input`, `textarea`, `select`, `[contenteditable]`, or a class
 *   the component puts on one of its fields;
 * - `.style.fontSize` (a literal) on fields made with `document.createElement`;
 * - the root font size `rem` is based on.
 *
 * `var(--…)` values are resolved through the custom properties declared in
 * the global stylesheet and the component itself. A size that cannot be
 * worked out (`em`, `%`, `inherit`, an unknown variable, a `{prop}`) fails:
 * write a token that resolves to px or rem so it can be checked.
 */
const MIN_FONT_SIZE_PX = 16;
const ROOT_FONT_SIZE_PX = 16;

const RAW_FIELDS = new Set(['input', 'textarea', 'select']);

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
		return `font size \`${shown}\` cannot be checked; use a token that resolves to at least ${MIN_FONT_SIZE_PX}px (1rem)`;
	}
	if (px < MIN_FONT_SIZE_PX) {
		return `font size \`${shown}\` (${px}px) is below ${MIN_FONT_SIZE_PX}px, so iPhones zoom in when it is tapped; use a 1rem token`;
	}
	return null;
}

/** The size part of a `font` shorthand, e.g. `600 var(--text-sm)/1.2 sans-serif`. */
function shorthandSize(value: string): string | null {
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

function selectsField(selector: string, fieldClasses: ReadonlySet<string>): boolean {
	if (selector.includes('::')) return false;
	const compounds = unwrapGlobal(selector)
		.trim()
		.split(/\s*[\s>+~]\s*/);
	const subject = compounds[compounds.length - 1] ?? '';
	if (/\[contenteditable/i.test(subject)) return true;
	for (const match of subject.matchAll(/\.([\w-]+)/g)) {
		if (fieldClasses.has(match[1] ?? '')) return true;
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

	for (const declaration of allDeclarations(file)) {
		const size = declaredSize(declaration);
		if (size === null) continue;
		const where = `Line ${declaration.line}:`;
		if (declaration.element !== null) {
			const label = fieldLabel(declaration.element);
			if (label === null) continue;
			const problem = declaration.dynamic
				? `font size \`${size}\` is computed and cannot be checked; use a token that resolves to at least ${MIN_FONT_SIZE_PX}px`
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
					`${where} root font size \`${size}\` changes what 1rem means, so rem-sized fields no longer meet the ${MIN_FONT_SIZE_PX}px iPhone minimum; leave it at 100%.`
				);
			}
			continue;
		}
		if (!selectors.some((s) => selectsField(s, fieldClasses))) continue;
		const problem = describeProblem(size, variables);
		if (problem !== null && problem !== '')
			issues.push(`${where} \`${(declaration.selector ?? '').replace(/\s+/g, ' ')}\` ${problem}.`);
	}

	const script = file.scriptText();
	if (script !== null) issues.push(...scanCreatedFields(script, variables));
	return issues;
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
					: `font size \`${raw}\` cannot be checked; assign a literal of at least ${MIN_FONT_SIZE_PX}px`;
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
	for (const file of files) {
		if (isTestFile(file.relPath)) continue;
		if (!file.isSvelte && !file.isCss && !file.isScript) continue;
		for (const issue of scanFontSizes(file, globals)) {
			report(INPUT_FONT_SIZE_RULE, file.relPath, issue);
		}
	}
}
