/**
 * Svelte template and stylesheet helpers shared by the rules: attribute
 * lookup on template elements, and the CSS declarations a component or
 * stylesheet writes (`<style>` blocks, `.css` files, `style="…"` attributes
 * and `style:` directives).
 */
import { parseCss, type AST } from 'svelte/compiler';
import { DYNAMIC_PLACEHOLDER, splitValue } from './css-values.ts';
import type { SourceFile } from './source-file.ts';

/** The named attribute (not a directive or spread) on an element. */
export function findAttribute(element: AST.ElementLike, name: string): AST.Attribute | undefined {
	for (const attribute of element.attributes) {
		if (attribute.type === 'Attribute' && attribute.name === name) return attribute;
	}
	return undefined;
}

/**
 * The literal text an attribute holds: "" when bare, the text of a quoted
 * value or a `{"string"}` expression, null when it is computed.
 */
export function attributeText(attribute: AST.Attribute): string | null {
	const value = attribute.value;
	if (value === true) return '';
	const parts = Array.isArray(value) ? value : [value];
	let text = '';
	for (const part of parts) {
		if (part.type === 'Text') {
			text += part.data;
		} else if (part.expression.type === 'Literal' && typeof part.expression.value === 'string') {
			text += part.expression.value;
		} else if (part.expression.type === 'Literal' && typeof part.expression.value === 'boolean') {
			text += String(part.expression.value);
		} else {
			return null;
		}
	}
	return text;
}

/** One CSS declaration written by a file. */
export interface CssDeclaration {
	readonly property: string;
	readonly value: string;
	/** Selector of the rule it sits in (null for style attributes). */
	readonly selector: string | null;
	/** Names of the at-rules it sits inside, e.g. `media`, `keyframes`. */
	readonly atRules: readonly string[];
	/** The element a style attribute or directive is on. */
	readonly element: AST.ElementLike | null;
	/** Whether the value has `{expressions}` that cannot be checked. */
	readonly dynamic: boolean;
	readonly line: number;
}

type CssChild = AST.CSS.Rule | AST.CSS.Atrule | AST.CSS.Declaration;

function collectDeclarations(
	file: SourceFile,
	children: readonly CssChild[],
	text: string,
	offset: number,
	selector: string | null,
	atRules: readonly string[],
	out: CssDeclaration[]
): void {
	for (const child of children) {
		if (child.type === 'Declaration') {
			out.push({
				property: child.property,
				value: child.value,
				selector,
				atRules,
				element: null,
				dynamic: false,
				line: file.lineAt(child.start + offset)
			});
		} else if (child.type === 'Rule') {
			const own = text.slice(child.prelude.start, child.prelude.end).trim();
			const combined =
				selector === null
					? own
					: own.includes('&')
						? own.replaceAll('&', selector)
						: `${selector} ${own}`;
			collectDeclarations(file, child.block.children, text, offset, combined, atRules, out);
		} else if (child.block) {
			collectDeclarations(
				file,
				child.block.children,
				text,
				offset,
				selector,
				[...atRules, child.name],
				out
			);
		}
	}
}

/** Declarations in a component's `<style>` block or a `.css` file. */
export function stylesheetDeclarations(file: SourceFile): CssDeclaration[] {
	const out: CssDeclaration[] = [];
	if (file.isCss) {
		let sheet;
		try {
			sheet = parseCss(file.content);
		} catch {
			// Stylelint reports CSS that does not parse.
			return out;
		}
		collectDeclarations(file, sheet.children, file.content, 0, null, [], out);
	} else {
		const css = file.svelte()?.root.css;
		if (css) collectDeclarations(file, css.children, file.content, 0, null, [], out);
	}
	return out;
}

/** The text of a style value, with each `{expression}` replaced by a placeholder. */
function styleValueText(value: true | AST.ExpressionTag | (AST.Text | AST.ExpressionTag)[]): {
	text: string;
	dynamic: boolean;
} {
	if (value === true) return { text: DYNAMIC_PLACEHOLDER, dynamic: true };
	const parts = Array.isArray(value) ? value : [value];
	let text = '';
	let dynamic = false;
	for (const part of parts) {
		if (part.type === 'Text') {
			text += part.data;
		} else if (part.expression.type === 'Literal' && typeof part.expression.value === 'string') {
			text += part.expression.value;
		} else {
			text += DYNAMIC_PLACEHOLDER;
			dynamic = true;
		}
	}
	return { text, dynamic };
}

/** Declarations in `style="…"` attributes and `style:property` directives. */
function styleAttributeDeclarations(file: SourceFile): CssDeclaration[] {
	const document = file.svelte();
	if (!document) return [];
	const out: CssDeclaration[] = [];
	for (const element of document.elements) {
		for (const attribute of element.attributes) {
			if (attribute.type === 'Attribute' && attribute.name === 'style') {
				const { text, dynamic } = styleValueText(attribute.value);
				for (const declaration of splitValue(text, /;/)) {
					const colon = declaration.indexOf(':');
					if (colon === -1) continue;
					out.push({
						property: declaration.slice(0, colon).trim(),
						value: declaration.slice(colon + 1).trim(),
						selector: null,
						atRules: [],
						element,
						dynamic,
						line: file.lineAt(attribute.start)
					});
				}
			} else if (attribute.type === 'StyleDirective') {
				const { text, dynamic } = styleValueText(attribute.value);
				out.push({
					property: attribute.name,
					value: text,
					selector: null,
					atRules: [],
					element,
					dynamic,
					line: file.lineAt(attribute.start)
				});
			}
		}
	}
	return out;
}

/** Every declaration a file writes: stylesheet and style attributes. */
export function allDeclarations(file: SourceFile): CssDeclaration[] {
	if (!file.isSvelte && !file.isCss) return [];
	return [...stylesheetDeclarations(file), ...styleAttributeDeclarations(file)];
}
