import { readFile } from 'node:fs/promises';
import { parse, type AST } from 'svelte/compiler';
import { extensionOf, repoPath, walkFiles } from './fs.ts';
import type { Reporter } from './report.ts';

/** Extensions whose contents the rules read. */
const readableExtensions: ReadonlySet<string> = new Set(['.ts', '.js', '.svelte', '.css']);

/** Element-like template nodes: HTML elements, components and `svelte:*` elements. */
const ELEMENT_TYPES = new Set([
	'RegularElement',
	'Component',
	'SvelteElement',
	'SvelteComponent',
	'SvelteSelf',
	'SvelteFragment',
	'SvelteBoundary',
	'SvelteBody',
	'SvelteDocument',
	'SvelteHead',
	'SvelteWindow',
	'SvelteOptions',
	'SlotElement',
	'TitleElement'
]);

/** Keys holding JavaScript (ESTree) rather than template nodes. */
const EXPRESSION_KEYS = new Set([
	'expression',
	'test',
	'context',
	'key',
	'tag',
	'parameters',
	'metadata',
	'name_loc',
	'loc'
]);

interface TemplateNodeLike {
	readonly type: string;
	readonly start: number;
}

function isTemplateNode(value: unknown): value is TemplateNodeLike {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		typeof value.type === 'string' &&
		'start' in value &&
		typeof value.start === 'number'
	);
}

function isElement(node: TemplateNodeLike): node is AST.ElementLike {
	return ELEMENT_TYPES.has(node.type);
}

function isEachBlock(node: TemplateNodeLike): node is AST.EachBlock {
	return node.type === 'EachBlock';
}

function isHtmlTag(node: TemplateNodeLike): node is AST.HtmlTag {
	return node.type === 'HtmlTag';
}

/** A parsed `.svelte` component, as the rules see it. */
export interface SvelteDocument {
	readonly root: AST.Root;
	/** The source with everything but `<script>` bodies blanked (offsets and lines kept). */
	readonly script: string;
	/** The source with `<script>` and `<style>` elements blanked. */
	readonly markup: string;
	/** Every element, component and `svelte:*` element in the template. */
	readonly elements: readonly AST.ElementLike[];
	readonly eachBlocks: readonly AST.EachBlock[];
	readonly htmlTags: readonly AST.HtmlTag[];
}

/** Replaces `[start, end)` ranges with spaces, keeping newlines. */
function blank(text: string, ranges: readonly (readonly [number, number])[]): string {
	let result = '';
	let from = 0;
	for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
		result += text.slice(from, start) + text.slice(start, end).replace(/[^\n]/g, ' ');
		from = end;
	}
	return result + text.slice(from);
}

/** The body of a `<script>` element: between its opening tag and `</script>`. */
function scriptBody(text: string, script: AST.Script): readonly [number, number] {
	const open = text.indexOf('>', script.start) + 1;
	const close = text.lastIndexOf('</script', script.end);
	return [open, close > open ? close : script.end];
}

function buildDocument(text: string, root: AST.Root): SvelteDocument {
	const scripts = [root.instance, root.module].filter((s): s is AST.Script => !!s);
	const bodies = scripts.map((s) => scriptBody(text, s));
	const outsideScripts: (readonly [number, number])[] = [];
	let from = 0;
	for (const [start, end] of [...bodies].sort((a, b) => a[0] - b[0])) {
		outsideScripts.push([from, start]);
		from = end;
	}
	outsideScripts.push([from, text.length]);

	const nonMarkup: (readonly [number, number])[] = scripts.map((s) => [s.start, s.end]);
	if (root.css) nonMarkup.push([root.css.start, root.css.end]);

	const elements: AST.ElementLike[] = [];
	const eachBlocks: AST.EachBlock[] = [];
	const htmlTags: AST.HtmlTag[] = [];
	const seen = new Set<object>();
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (typeof value !== 'object' || value === null || seen.has(value)) return;
		seen.add(value);
		if (isTemplateNode(value)) {
			if (isElement(value)) elements.push(value);
			else if (isEachBlock(value)) eachBlocks.push(value);
			else if (isHtmlTag(value)) htmlTags.push(value);
		}
		for (const [key, child] of Object.entries(value)) {
			if (!EXPRESSION_KEYS.has(key)) visit(child);
		}
	};
	visit(root.fragment);

	return {
		root,
		script: blank(text, outsideScripts),
		markup: blank(text, nonMarkup),
		elements,
		eachBlocks,
		htmlTags
	};
}

/** A readable file under src/, as the rules see it. */
export class SourceFile {
	/** Repo-relative path with forward slashes, e.g. `src/lib/ui/button.svelte`. */
	readonly relPath: string;
	/** Lower-case extension including the dot, e.g. `.svelte`. */
	readonly extension: string;
	readonly content: string;
	readonly lineCount: number;
	#lineStarts: number[] | null = null;
	#svelte: SvelteDocument | null = null;
	#parseError: string | null = null;

	constructor(relPath: string, content: string) {
		this.relPath = relPath;
		this.extension = extensionOf(relPath);
		this.content = content;
		this.lineCount = content.split('\n').length;
	}

	get isSvelte(): boolean {
		return this.extension === '.svelte';
	}

	/** TypeScript or JavaScript source (including `*.svelte.ts`). */
	get isScript(): boolean {
		return this.extension === '.ts' || this.extension === '.js';
	}

	get isCss(): boolean {
		return this.extension === '.css';
	}

	/** The parsed component, or null when this is not a `.svelte` file or it does not parse. */
	svelte(): SvelteDocument | null {
		if (!this.isSvelte || this.#parseError !== null) return null;
		if (this.#svelte === null) {
			try {
				this.#svelte = buildDocument(
					this.content,
					parse(this.content, { modern: true, filename: this.relPath })
				);
			} catch (error) {
				this.#parseError = error instanceof Error ? error.message : String(error);
				return null;
			}
		}
		return this.#svelte;
	}

	/** Why the component does not parse, after `svelte()` returned null. */
	get parseError(): string | null {
		return this.#parseError;
	}

	/**
	 * The JavaScript/TypeScript the file runs: the whole file for scripts, the
	 * `<script>` bodies (other text blanked, offsets kept) for components, and
	 * null for anything else.
	 */
	scriptText(): string | null {
		if (this.isScript) return this.content;
		return this.svelte()?.script ?? null;
	}

	/** One-based line of a character offset. */
	lineAt(offset: number): number {
		if (this.#lineStarts === null) {
			const starts = [0];
			for (let i = 0; i < this.content.length; i++) {
				if (this.content[i] === '\n') starts.push(i + 1);
			}
			this.#lineStarts = starts;
		}
		let low = 0;
		let high = this.#lineStarts.length - 1;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			const start = this.#lineStarts[middle];
			if (start !== undefined && start <= offset) low = middle;
			else high = middle - 1;
		}
		return low + 1;
	}
}

/**
 * `svelte-parse-error`: a component svelte/compiler cannot parse. Returns
 * whether the file can be checked by the other rules.
 */
export function checkSvelteParses(file: SourceFile, { violation }: Reporter): boolean {
	if (!file.isSvelte || file.svelte() !== null) return true;
	violation(
		'svelte-parse-error',
		file.relPath,
		`svelte/compiler could not parse this component: ${file.parseError ?? 'unknown error'}`
	);
	return false;
}

/** Every file under src/ (for path rules) and the readable ones, loaded once. */
export interface SourceTree {
	readonly paths: readonly string[];
	readonly files: readonly SourceFile[];
}

/** Folders whose files are generated and never checked. */
const GENERATED_FOLDERS: ReadonlySet<string> = new Set(['migrations']);

export async function loadSourceTree(workspaceRoot: string): Promise<SourceTree> {
	const absolute = await walkFiles(`${workspaceRoot}/src`, { skipFolders: GENERATED_FOLDERS });
	const paths = absolute.map((path) => repoPath(workspaceRoot, path));
	const files = await Promise.all(
		absolute
			.filter((path) => readableExtensions.has(extensionOf(path)))
			.map(
				async (path) => new SourceFile(repoPath(workspaceRoot, path), await readFile(path, 'utf8'))
			)
	);
	return { paths, files };
}

/** Tests are never held to the source rules that concern shipped code. */
export function isTestFile(relPath: string): boolean {
	return /\.test\.(ts|js)$/.test(relPath);
}

/**
 * Server-only code: `src/lib/server/**`, `*.server.ts` modules (page and
 * layout server files, hooks) and `+server.ts` endpoints.
 */
export function isServerOnly(relPath: string): boolean {
	return (
		relPath.startsWith('src/lib/server/') ||
		/\.server\.(ts|js)$/.test(relPath) ||
		/(^|\/)\+server\.(ts|js)$/.test(relPath)
	);
}

/** Files that render UI or run in the browser for it: components, routes, shared UI and state. */
export function isUiSourceFile(relPath: string): boolean {
	if (isServerOnly(relPath)) return false;
	return (
		relPath.endsWith('.svelte') ||
		relPath.startsWith('src/routes/') ||
		relPath.startsWith('src/lib/ui/') ||
		relPath.startsWith('src/lib/shell/') ||
		relPath.startsWith('src/lib/runes/')
	);
}

/** Shared components that are the standard controls themselves (AGENTS.md §12). */
const STANDARD_CONTROL_FILES: ReadonlySet<string> = new Set([
	'src/lib/ui/button.svelte',
	'src/lib/ui/text-field.svelte'
]);

export function isStandardControl(relPath: string): boolean {
	return STANDARD_CONTROL_FILES.has(relPath);
}
