import type { AST } from 'svelte/compiler';
import type { Report } from './report.ts';
import type { RuleIdOf } from './rules.ts';
import { isServerOnly, isStandardControl, type SourceFile } from './source-file.ts';
import { attributeText, findAttribute } from './template.ts';

/**
 * Standard controls (AGENTS.md §12): action buttons are `<Button>`
 * (src/lib/ui/button.svelte) and form fields are `<TextField>`
 * (src/lib/ui/text-field.svelte). A raw `<button>`, `<input>`, `<select>` or
 * `<textarea>` in a route or shared component is only allowed for a
 * specialised widget, and must say which kind with a reason from the lists
 * below: `<button data-raw-button="icon">`, `<input data-raw-input="list-search">`.
 * A bare or unknown reason fails, so every exception is self-documenting and
 * a lazy bypass stands out in review. Each element is checked on its own.
 */
const RAW_BUTTON_RULE = 'raw-button-reason-required';
const RAW_INPUT_RULE = 'raw-input-reason-required';

/** Why a `<button>` cannot be the standard `<Button>`. */
const RAW_BUTTON_REASONS: Readonly<Record<string, string>> = {
	icon: 'icon-only button (close, copy, toolbar action, stepper, clear)',
	tab: 'tab in a tab bar',
	segment: 'item in a segmented control',
	'list-row': 'list, tree or table row, or a disclosure row',
	'menu-item': 'item in a menu or dropdown (or its trigger)',
	chip: 'chip, filter or toggle chip that shows a selected state',
	card: 'card or option tile that is clickable as a whole',
	key: 'key on an on-screen keyboard row (Esc, Tab, Ctrl, arrows)',
	backdrop: 'full-screen modal or drawer backdrop'
};

/** Why an `<input>`, `<select>` or `<textarea>` cannot be the standard field. */
const RAW_INPUT_REASONS: Readonly<Record<string, string>> = {
	'list-search': 'search box that filters a list as you type',
	'terminal-command': 'command line of a terminal session',
	'row-select': 'selection checkbox in a table, list or tree row',
	'file-picker': 'hidden file input opened by a button',
	'code-entry': 'one-time code or verification digit entry'
};

const FIELD_TAGS = new Set(['input', 'select', 'textarea']);

const FIELD_HELP = 'use <TextField> from src/lib/ui/text-field.svelte';

interface RawControlIssue {
	readonly rule: RuleIdOf<'violation'>;
	readonly line: number;
	readonly details: string;
}

/** Applies to components outside the standard controls themselves. */
function isRawControlScope(relPath: string): boolean {
	if (!relPath.endsWith('.svelte') || isServerOnly(relPath)) return false;
	if (isStandardControl(relPath)) return false;
	return relPath.startsWith('src/routes/') || relPath.startsWith('src/lib/');
}

function reasonList(reasons: Readonly<Record<string, string>>): string {
	return Object.keys(reasons).join(', ');
}

function scanRawControlFile(file: SourceFile): RawControlIssue[] {
	if (!isRawControlScope(file.relPath)) return [];
	const document = file.svelte();
	if (!document) return [];
	const issues: RawControlIssue[] = [];

	const check = (element: AST.ElementLike): void => {
		if (element.type !== 'RegularElement') return;
		const tag = element.name;
		const isButton = tag === 'button';
		if (!isButton && !FIELD_TAGS.has(tag)) return;
		const line = file.lineAt(element.start);
		const add = (rule: RuleIdOf<'violation'>, details: string): void => {
			issues.push({ rule, line, details: `line ${line}: <${tag}> ${details}` });
		};

		if (tag === 'input') {
			const type = findAttribute(element, 'type');
			if (type && attributeText(type) === 'hidden') return;
		}

		const rule = isButton ? RAW_BUTTON_RULE : RAW_INPUT_RULE;
		const name = isButton ? 'data-raw-button' : 'data-raw-input';
		const reasons = isButton ? RAW_BUTTON_REASONS : RAW_INPUT_REASONS;
		const help = isButton ? 'use <Button> from src/lib/ui/button.svelte' : FIELD_HELP;

		const wrongName = isButton ? 'data-raw-input' : 'data-raw-button';
		if (findAttribute(element, wrongName)) {
			add(rule, `carries ${wrongName}; a <${tag}> uses ${name}`);
			return;
		}

		const found = findAttribute(element, name);
		if (!found) {
			add(
				rule,
				`${help}, or for a specialised widget add ${name}="<reason>" (${reasonList(reasons)})`
			);
			return;
		}
		const reason = attributeText(found);
		if (reason === null || !(reason in reasons)) {
			add(
				rule,
				`${name} needs a literal reason from: ${reasonList(reasons)}${
					reason !== null && reason !== '' ? ` (found "${reason}")` : ''
				}. If none fits, ${help}`
			);
		}
	};

	for (const element of document.elements) check(element);
	return issues;
}

/** Runs the raw control rules over one file. */
export function checkRawControls(file: SourceFile, report: Report): void {
	for (const issue of scanRawControlFile(file)) {
		report(issue.rule, file.relPath, issue.details);
	}
}
