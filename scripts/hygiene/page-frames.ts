import { dirname, join, normalize } from 'node:path';
import type { Report } from './report.ts';
import { isTestFile, type SourceFile } from './source-file.ts';
import { stylesheetDeclarations, type CssDeclaration } from './template.ts';

/**
 * Page frames (AGENTS.md §4): every page sits in one of two frames, and only
 * the frames decide where the page's edges are, so nothing lands under a
 * phone's status bar, notch or home bar.
 *
 * - `page-frame-required`: every `+page.svelte` (and `+page@….svelte`,
 *   `+error.svelte`) renders inside a frame: one of its layouts, or the page
 *   itself, uses ShellFrame or PublicPage, directly or through a component
 *   built on them.
 * - `page-root-container-forbidden`: a full-screen-height container
 *   (`min-height: 100vh` / `svh` / `dvh` / `lvh`) outside the frames is a
 *   page building its own frame.
 * - `fixed-edge-safe-area`: a `position: fixed` element pinned to the top or
 *   bottom of the screen offsets itself by the safe-area inset
 *   (`var(--safe-top)` / `var(--safe-bottom)`), or sits flush on that edge
 *   (`bottom: 0`) and pads its content by the inset (`padding-bottom:
 *   var(--safe-bottom)`), as the phone tab bar does. A full-screen layer
 *   (`inset: 0`, or both `top: 0` and `bottom: 0`) is exempt: it is meant to
 *   cover the whole screen.
 */
const FRAME_RULE = 'page-frame-required';
const ROOT_CONTAINER_RULE = 'page-root-container-forbidden';
const FIXED_EDGE_RULE = 'fixed-edge-safe-area';

/** The two frames. Everything built on them counts as a frame too. */
const BASE_FRAMES: readonly string[] = [
	'src/lib/shell/shell-frame.svelte',
	'src/lib/shell/public-page.svelte'
];

const ROUTES = 'src/routes/';

/** `.svelte` files a component imports, as repository paths. */
function svelteImports(file: SourceFile): string[] {
	const script = file.isSvelte ? (file.scriptText() ?? '') : file.content;
	const imports: string[] = [];
	for (const match of script.matchAll(/from\s+['"]([^'"]+\.svelte)['"]/g)) {
		const specifier = match[1] ?? '';
		if (specifier.startsWith('#lib/')) {
			imports.push(`src/lib/${specifier.slice('#lib/'.length)}`);
		} else if (specifier.startsWith('.')) {
			imports.push(normalize(join(dirname(file.relPath), specifier)));
		}
	}
	return imports;
}

/** The frames: the base frames and every component that renders one. */
function frameComponents(files: readonly SourceFile[]): Set<string> {
	const frames = new Set(BASE_FRAMES);
	const components = files.filter((f) => f.isSvelte);
	let grew = true;
	while (grew) {
		grew = false;
		for (const component of components) {
			if (frames.has(component.relPath)) continue;
			if (svelteImports(component).some((path) => frames.has(path))) {
				frames.add(component.relPath);
				grew = true;
			}
		}
	}
	return frames;
}

/** Route files that render a page: pages, pages that reset their layouts, error pages. */
function isPageFile(relPath: string): boolean {
	const name = relPath.slice(relPath.lastIndexOf('/') + 1);
	return /^\+page(@[^.]*)?\.svelte$/.test(name) || name === '+error.svelte';
}

/**
 * The layout files a page renders inside, nearest first. `+page@.svelte`
 * resets to the root layout; `+page@segment.svelte` to that segment's.
 */
function applicableLayouts(relPath: string, layouts: ReadonlySet<string>): string[] {
	const name = relPath.slice(relPath.lastIndexOf('/') + 1);
	const reset = /^\+page@([^.]*)\.svelte$/.exec(name);
	let dir = dirname(relPath);
	if (reset) {
		const target = reset[1] ?? '';
		while (dir !== 'src/routes' && (target === '' || !dir.endsWith(`/${target}`))) {
			dir = dirname(dir);
		}
	}
	const found: string[] = [];
	for (;;) {
		const layout = `${dir}/+layout.svelte`;
		if (layouts.has(layout)) found.push(layout);
		if (dir === 'src/routes' || !dir.startsWith('src/routes')) break;
		dir = dirname(dir);
	}
	return found;
}

/** Pages that render outside both frames. */
function unframedPages(files: readonly SourceFile[]): string[] {
	const frames = frameComponents(files);
	const byPath = new Map(files.map((f) => [f.relPath, f]));
	const layouts = new Set(
		files
			.filter((f) => f.relPath.startsWith(ROUTES) && f.relPath.endsWith('/+layout.svelte'))
			.map((f) => f.relPath)
	);
	const usesFrame = (relPath: string): boolean => {
		const source = byPath.get(relPath);
		return source !== undefined && svelteImports(source).some((path) => frames.has(path));
	};
	return files
		.filter((f) => f.relPath.startsWith(ROUTES) && isPageFile(f.relPath))
		.filter((f) => !usesFrame(f.relPath) && !applicableLayouts(f.relPath, layouts).some(usesFrame))
		.map((f) => f.relPath);
}

/** `min-height` in viewport-height units: a page sizing itself to the screen. */
function screenHeightContainers(file: SourceFile): CssDeclaration[] {
	return stylesheetDeclarations(file).filter(
		(d) => d.property.trim().toLowerCase() === 'min-height' && /\b100(s|d|l)?vh\b/.test(d.value)
	);
}

function isZero(value: string): boolean {
	return /^0(px|rem|%)?$/.test(value.trim());
}

/** Pinned edges of fixed elements that ignore the safe-area insets. */
function unsafeFixedEdges(file: SourceFile): string[] {
	const rules = new Map<string, CssDeclaration[]>();
	for (const declaration of stylesheetDeclarations(file)) {
		const key = `${declaration.atRules.join('/')}|${declaration.selector ?? ''}`;
		rules.set(key, [...(rules.get(key) ?? []), declaration]);
	}
	const issues: string[] = [];
	for (const declarations of rules.values()) {
		const value = (property: string): string | null =>
			declarations.find((d) => d.property.trim().toLowerCase() === property)?.value.trim() ?? null;
		if (value('position') !== 'fixed') continue;
		const inset = value('inset');
		const top = value('top');
		const bottom = value('bottom');
		const fullScreen =
			(inset !== null && isZero(inset)) ||
			(top !== null && bottom !== null && isZero(top) && isZero(bottom));
		if (fullScreen) continue;
		/** A flush edge whose padding on that side includes the inset. */
		const padsInset = (edge: 'top' | 'bottom'): boolean =>
			[value(`padding-${edge}`), value('padding')].some(
				(padding) => padding?.includes(`--safe-${edge}`) === true
			);
		for (const declaration of declarations) {
			const property = declaration.property.trim().toLowerCase();
			if (property !== 'top' && property !== 'bottom' && property !== 'inset') continue;
			const shown = declaration.value.trim();
			if (shown === 'auto' || shown.includes('--safe-')) continue;
			if (property !== 'inset' && isZero(shown) && padsInset(property)) continue;
			issues.push(
				`Line ${declaration.line}: \`${(declaration.selector ?? '').trim()}\` is fixed with \`${property}: ${shown}\`, which puts it under the status bar or home bar on phones; add the inset, e.g. \`calc(${shown} + var(--safe-${property === 'bottom' ? 'bottom' : 'top'}))\`.`
			);
		}
	}
	return issues;
}

export function verifyPageFrames(files: readonly SourceFile[], report: Report): void {
	for (const relPath of unframedPages(files)) {
		report(
			FRAME_RULE,
			relPath,
			'renders outside ShellFrame and PublicPage; put it under the (console) layout or wrap it in <PublicPage> (#lib/shell/public-page.svelte).'
		);
	}
	const frames = new Set(BASE_FRAMES);
	for (const file of files) {
		if (isTestFile(file.relPath) || (!file.isSvelte && !file.isCss)) continue;
		if (!frames.has(file.relPath)) {
			for (const declaration of screenHeightContainers(file)) {
				report(
					ROOT_CONTAINER_RULE,
					file.relPath,
					`Line ${declaration.line}: \`min-height: ${declaration.value.trim()}\` makes a page frame of its own; only ShellFrame and PublicPage size themselves to the screen.`
				);
			}
		}
		for (const issue of unsafeFixedEdges(file)) report(FIXED_EDGE_RULE, file.relPath, issue);
	}
}
