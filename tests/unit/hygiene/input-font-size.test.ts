/**
 * What hygiene rule input-font-size-ios-zoom lets through and what it stops,
 * and that every message says why (iOS zooms the page on small text boxes).
 */
import { describe, expect, it } from 'vitest';
import { verifyInputFontSize } from '../../../scripts/hygiene/input-font-size.ts';
import { SourceFile } from '../../../scripts/hygiene/source-file.ts';

const WHY = 'iOS zooms the page when a text box under 16px is focused';

const TOKENS = new SourceFile(
	'src/lib/ui/design-tokens.css',
	':root {\n\t--text-xs: 0.75rem;\n\t--text-sm: 0.875rem;\n\t--text-base: 1rem;\n\t--text-lg: 1.125rem;\n}'
);

/** The messages the rule reports for one component holding `markup` and `css`. */
function messages(markup: string, css: string): string[] {
	const found: string[] = [];
	const component = new SourceFile(
		'src/routes/(console)/example.svelte',
		`${markup}\n<style>\n${css}\n</style>`
	);
	verifyInputFontSize([component], [TOKENS], (_rule, _path, message) => {
		found.push(message);
	});
	return found;
}

describe('input-font-size-ios-zoom', () => {
	it.each([
		['var(--text-base)'],
		['var(--text-lg)'],
		['1rem'],
		['16px'],
		['1.25rem'],
		['var(--missing, 1rem)']
	])('lets a text box use %s', (size) => {
		expect(messages('<input class="box" />', `.box { font-size: ${size}; }`)).toEqual([]);
	});

	it.each([
		['var(--text-sm)'],
		['var(--text-xs)'],
		['14px'],
		['0.875rem'],
		['0.9em'],
		['1em'],
		['inherit'],
		['unset'],
		['90%'],
		['calc(1rem - 2px)'],
		['clamp(12px, 2vw, 18px)'],
		['min(1rem, 3vw)'],
		['var(--unknown)']
	])('stops a text box using %s, and says why', (size) => {
		const found = messages('<input class="box" />', `.box { font-size: ${size}; }`);
		expect(found).toHaveLength(1);
		expect(found[0]).toContain(WHY);
	});

	it('checks every kind of text box: element names, classes and contenteditable', () => {
		const small = 'font-size: var(--text-sm);';
		expect(messages('<textarea></textarea>', `textarea { ${small} }`)).toHaveLength(1);
		expect(messages('<select class="pick"></select>', `.pick { ${small} }`)).toHaveLength(1);
		expect(
			messages('<div class="t" contenteditable="true"></div>', `.t { ${small} }`)
		).toHaveLength(1);
		expect(messages('<input type="email" class="e" />', `.e { ${small} }`)).toHaveLength(1);
		expect(messages('<input />', `input { ${small} }`)).toHaveLength(1);
	});

	it('leaves boxes that never show a keyboard, and text near a box, alone', () => {
		const small = 'font-size: var(--text-sm);';
		expect(messages('<input type="checkbox" class="tick" />', `.tick { ${small} }`)).toEqual([]);
		expect(messages('<input type="range" class="r" />', `.r { ${small} }`)).toEqual([]);
		expect(
			messages(
				'<label class="field"><span class="hint">Hint</span><input class="box" /></label>',
				`.field { ${small} }\n.hint { ${small} }\n.box { font-size: var(--text-base); }`
			)
		).toEqual([]);
	});

	it("checks xterm's hidden textarea through :global()", () => {
		const found = messages(
			'<div class="session"></div>',
			'.session :global(.xterm-helper-textarea) { font-size: 12px; }'
		);
		expect(found).toHaveLength(1);
		expect(found[0]).toContain(WHY);
	});

	it('stops `font: inherit` on a text box unless the rule then sets a size', () => {
		expect(messages('<input class="box" />', '.box { font: inherit; }')[0]).toContain(WHY);
		expect(
			messages('<input class="box" />', '.box { font: inherit; font-size: var(--text-base); }')
		).toEqual([]);
		expect(messages('<button class="b"></button>', '.b { font: inherit; }')).toEqual([]);
	});

	it('requires the 16px base rule in src/app.css, naming what it misses', () => {
		const found: string[] = [];
		const app = new SourceFile('src/app.css', 'input { font-size: var(--text-base); }');
		verifyInputFontSize([], [TOKENS, app], (_rule, _path, message) => {
			found.push(message);
		});
		expect(found).toHaveLength(1);
		expect(found[0]).toContain('`textarea`, `select`, `[contenteditable]`');
		expect(found[0]).toContain(WHY);
	});
});
