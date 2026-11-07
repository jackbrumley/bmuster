import type { Report } from './report.ts';
import { isTestFile, type SourceFile } from './source-file.ts';
import { stylesheetDeclarations, type CssDeclaration } from './template.ts';

/**
 * Page structure (AGENTS.md §4): pages are built from the shared blocks in
 * src/lib/ui, so every page has the same header, the same cards and the
 * same rhythm, and copies cannot drift apart.
 *
 * - `route-card-look-forbidden`: a component under src/routes/ may not draw
 *   a card of its own. A card look is one CSS rule that gives an element the
 *   card or modal radius (`var(--radius-card)` / `var(--radius-modal)`)
 *   together with a visible `border` or a `box-shadow`, or any use of the
 *   raised-surface shadows (`--shadow-card`, `--shadow-popover`). Both parts
 *   are needed, so a rounded terminal or remote screen (radius, no border or
 *   shadow) and a bordered input (control radius) are not cards; this keeps
 *   false positives near zero. Use Panel, ListCard or another component in
 *   src/lib/ui instead.
 * - `page-header-required`: every page under src/routes/(console)/ renders
 *   `<PageHeader>` so titles sit in the same place on every page, unless a
 *   layout above it renders the header for it (PAGE_HEADER_FROM_LAYOUT).
 */
const CARD_RULE = 'route-card-look-forbidden';
const HEADER_RULE = 'page-header-required';

const ROUTES = 'src/routes/';
const CONSOLE = 'src/routes/(console)/';

/**
 * Folders whose pages take their header from a layout, with the reason.
 * Every page below the folder is exempt.
 */
const PAGE_HEADER_FROM_LAYOUT: Readonly<Record<string, string>> = {
	'src/routes/(console)/machines/[id]/':
		'the machine layout renders the machine header and tab bar above every machine tab'
};

const CARD_RADIUS = /var\(\s*--radius-(card|modal)\s*\)/;
const RAISED_SHADOW = /--shadow-(card|popover)\b/;

/** A border or shadow value that draws nothing. */
function isNone(value: string): boolean {
	return /^(none|0(px)?|transparent)$/.test(value.trim());
}

/** One CSS rule's declarations, keyed by at-rules and selector. */
function rules(file: SourceFile): CssDeclaration[][] {
	const grouped = new Map<string, CssDeclaration[]>();
	for (const declaration of stylesheetDeclarations(file)) {
		if (declaration.selector === null) continue;
		const key = `${declaration.atRules.join('/')}|${declaration.selector}`;
		grouped.set(key, [...(grouped.get(key) ?? []), declaration]);
	}
	return [...grouped.values()];
}

/** Lines in a route component that declare a card look. */
function cardLooks(file: SourceFile): string[] {
	const issues: string[] = [];
	for (const declarations of rules(file)) {
		const selector = (declarations[0]?.selector ?? '').trim();
		const shadow = declarations.find((d) => RAISED_SHADOW.test(d.value));
		if (shadow !== undefined) {
			issues.push(
				`Line ${shadow.line}: \`${selector}\` uses \`${shadow.value.trim()}\`, the raised-card shadow.`
			);
			continue;
		}
		const radius = declarations.find(
			(d) => d.property.trim().toLowerCase() === 'border-radius' && CARD_RADIUS.test(d.value)
		);
		if (radius === undefined) continue;
		const edge = declarations.find((d) => {
			const property = d.property.trim().toLowerCase();
			return (property === 'border' || property === 'box-shadow') && !isNone(d.value);
		});
		if (edge !== undefined) {
			issues.push(
				`Line ${radius.line}: \`${selector}\` has the card radius and \`${edge.property.trim()}: ${edge.value.trim()}\`, a card of its own.`
			);
		}
	}
	return issues;
}

function isConsolePage(relPath: string): boolean {
	return relPath.startsWith(CONSOLE) && relPath.endsWith('/+page.svelte');
}

function headerFromLayout(relPath: string): boolean {
	return Object.keys(PAGE_HEADER_FROM_LAYOUT).some((folder) => relPath.startsWith(folder));
}

function rendersPageHeader(file: SourceFile): boolean {
	const script = file.scriptText() ?? '';
	return (
		/from\s+['"]#lib\/ui\/page-header\.svelte['"]/.test(script) &&
		/<PageHeader\b/.test(file.content)
	);
}

export function verifyPageStructure(files: readonly SourceFile[], report: Report): void {
	for (const file of files) {
		if (!file.isSvelte || isTestFile(file.relPath) || !file.relPath.startsWith(ROUTES)) continue;
		for (const issue of cardLooks(file)) {
			report(CARD_RULE, file.relPath, `${issue} Use Panel or ListCard from src/lib/ui instead.`);
		}
		if (
			isConsolePage(file.relPath) &&
			!headerFromLayout(file.relPath) &&
			!rendersPageHeader(file)
		) {
			report(
				HEADER_RULE,
				file.relPath,
				'renders no <PageHeader>; start the page with <PageHeader title=… summary=… actions=…> from #lib/ui/page-header.svelte.'
			);
		}
	}
}
