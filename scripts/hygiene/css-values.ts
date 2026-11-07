/**
 * CSS value checks for scoped styles (AGENTS.md §4): visual values come
 * from design-token custom properties, `var(--…)`.
 *
 * Allowed in a value:
 * - `var(--token)`, with a fallback that is itself allowed;
 * - `calc()`, `min()`, `max()`, `clamp()` of allowed values, unitless
 *   numbers and operators;
 * - `0`, unitless numbers (z-index, flex, opacity, line-height, aspect
 *   ratios; not font-weight, which has tokens);
 * - layout units: `%`, `fr`, viewport units, angles, times and resolutions;
 * - 1px and 2px in border and outline widths (hairlines have no token);
 * - keywords (`auto`, `inherit`, `transparent`, `currentColor`, `flex`, …),
 *   strings, `url()` and other functions whose arguments are allowed.
 *
 * - lengths in component dimensions (width, height, positions, flex-basis,
 *   grid tracks, transforms, …): sizes belong to the component, not the scale.
 *
 * Refused: lengths in the properties the token scale governs (spacing —
 * margin, padding, gap —, font-size, letter-spacing, shadows, radius), and
 * colours (hex, `rgb()`, `hsl()`, named colours), which are reported
 * separately.
 */

export interface ValueProblem {
	readonly kind: 'colour' | 'raw';
	readonly text: string;
}

/** Stands in for a `{expression}` inside a style attribute: it cannot be checked statically. */
export const DYNAMIC_PLACEHOLDER = '__dynamic__';

/** Properties whose values are names or grid/content syntax, not visual values. */
const UNCHECKED_PROPERTIES = new Set([
	'content',
	'quotes',
	'grid-template-areas',
	'grid-area',
	'grid-column',
	'grid-column-start',
	'grid-column-end',
	'grid-row',
	'grid-row-start',
	'grid-row-end',
	'animation-name',
	'transition-property',
	'will-change',
	'counter-reset',
	'counter-increment',
	'counter-set',
	'src',
	'unicode-range',
	'font-display',
	'font-feature-settings',
	'font-variation-settings'
]);

/** Properties whose lengths must come from the token scale. */
function governsLength(property: string): boolean {
	return (
		/^(margin|padding|scroll-margin|scroll-padding)(-|$)/.test(property) ||
		/^(gap|row-gap|column-gap)$/.test(property) ||
		/^(font-size|letter-spacing|box-shadow|text-shadow)$/.test(property) ||
		/(^|-)radius$/.test(property) ||
		property === 'font'
	);
}

const LAYOUT_UNITS = new Set([
	'%',
	'fr',
	'vh',
	'vw',
	'dvh',
	'dvw',
	'svh',
	'svw',
	'lvh',
	'lvw',
	'vmin',
	'vmax',
	'cqw',
	'cqh',
	'cqi',
	'cqb',
	'deg',
	'rad',
	'grad',
	'turn',
	's',
	'ms',
	'x',
	'dppx',
	'dpi',
	'dpcm'
]);

const COLOUR_FUNCTIONS = new Set([
	'rgb',
	'rgba',
	'hsl',
	'hsla',
	'hwb',
	'lab',
	'lch',
	'oklab',
	'oklch',
	'color'
]);

const MATH_FUNCTIONS = new Set(['calc', 'min', 'max', 'clamp']);
const OPAQUE_FUNCTIONS = new Set([
	'url',
	'format',
	'local',
	'attr',
	'env',
	'counter',
	'counters',
	'tech'
]);

const NAMED_COLOURS: ReadonlySet<string> = new Set([
	'white',
	'black',
	'red',
	'green',
	'blue',
	'yellow',
	'orange',
	'purple',
	'pink',
	'grey',
	'gray',
	'brown',
	'cyan',
	'magenta',
	'navy',
	'teal',
	'maroon',
	'olive',
	'lime',
	'aqua',
	'fuchsia',
	'silver',
	'gold',
	'coral',
	'salmon',
	'tomato',
	'indigo',
	'violet',
	'beige',
	'ivory',
	'khaki',
	'crimson',
	'whitesmoke',
	'lightgrey',
	'lightgray',
	'darkgrey',
	'darkgray',
	'dimgray',
	'dimgrey'
]);

/** Splits a value into top-level tokens (whitespace, commas and `/` separate). */
export function splitValue(value: string, separators = /[\s,/]/): string[] {
	const tokens: string[] = [];
	let current = '';
	let depth = 0;
	let quote: string | null = null;
	for (const ch of value) {
		if (quote !== null) {
			current += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			current += ch;
			continue;
		}
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (depth === 0 && separators.test(ch)) {
			if (current) tokens.push(current);
			current = '';
			continue;
		}
		current += ch;
	}
	if (current) tokens.push(current);
	return tokens;
}

/** Splits function arguments on top-level commas. */
function splitArguments(args: string): string[] {
	return splitValue(args, /,/).map((a) => a.trim());
}

const NUMBER = /^[+-]?(\d*\.)?\d+(e[+-]?\d+)?$/i;
const DIMENSION = /^[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?([a-z%]+)$/i;
const FUNCTION = /^(-?[a-z][a-z0-9-]*)\(([\s\S]*)\)$/i;

interface Context {
	readonly property: string;
	readonly math: boolean;
}

function checkToken(token: string, context: Context, problems: ValueProblem[]): void {
	const lower = token.toLowerCase();
	if (token === DYNAMIC_PLACEHOLDER || token.includes(DYNAMIC_PLACEHOLDER)) return;
	if (token.startsWith('"') || token.startsWith("'")) return;
	if (token.startsWith('#')) {
		problems.push({ kind: /^#[0-9a-f]{3,8}$/i.test(token) ? 'colour' : 'raw', text: token });
		return;
	}
	const fn = FUNCTION.exec(token);
	if (fn) {
		const name = (fn[1] ?? '').toLowerCase();
		const args = fn[2] ?? '';
		if (name === 'var') {
			const [variable = '', ...fallback] = splitArguments(args);
			if (!variable.startsWith('--')) problems.push({ kind: 'raw', text: token });
			if (fallback.length > 0) checkTokens(fallback.join(', '), context, problems);
			return;
		}
		if (COLOUR_FUNCTIONS.has(name)) {
			problems.push({ kind: 'colour', text: token });
			return;
		}
		if (OPAQUE_FUNCTIONS.has(name)) return;
		checkTokens(
			args,
			{ property: context.property, math: MATH_FUNCTIONS.has(name) || context.math },
			problems
		);
		return;
	}
	if (context.math && ['+', '-', '*', '/'].includes(token)) return;
	if (NUMBER.test(token)) {
		if (Number(token) !== 0 && context.property === 'font-weight' && !context.math) {
			problems.push({ kind: 'raw', text: token });
		}
		return;
	}
	const dimension = DIMENSION.exec(token);
	if (dimension) {
		const unit = (dimension[1] ?? '').toLowerCase();
		if (LAYOUT_UNITS.has(unit) || Number.parseFloat(token) === 0) return;
		if (!governsLength(context.property)) return;
		const hairline =
			(lower === '1px' || lower === '2px') &&
			(context.property.startsWith('border') || context.property.startsWith('outline'));
		if (!hairline) problems.push({ kind: 'raw', text: token });
		return;
	}
	if (/^-?[a-z_][a-z0-9_-]*$/i.test(token)) {
		if (NAMED_COLOURS.has(lower)) problems.push({ kind: 'colour', text: token });
		return;
	}
	problems.push({ kind: 'raw', text: token });
}

function checkTokens(value: string, context: Context, problems: ValueProblem[]): void {
	for (const token of splitValue(value)) checkToken(token, context, problems);
}

/** Every token in a declaration's value that does not come from a design token. */
export function checkCssValue(property: string, value: string): ValueProblem[] {
	const name = property.trim().toLowerCase();
	if (UNCHECKED_PROPERTIES.has(name)) return [];
	const problems: ValueProblem[] = [];
	checkTokens(value.replace(/!important/gi, '').trim(), { property: name, math: false }, problems);
	return problems;
}
