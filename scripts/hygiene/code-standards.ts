import type { Reporter } from './report.ts';
import type { SourceFile } from './source-file.ts';

const lintBypassRegex = /\b(eslint-disable|ts-ignore|ts-expect-error|ts-nocheck|svelte-ignore)\b/;
const anyTypeRegex = /:\s*any\b|<\s*any\s*>|\bas\s+any\b/;
const inlineDependencyRegex = /from\s+["'](?:npm|jsr|https?):/;
const organizationZRegex = /\borganization/i;

/**
 * A cookie set on a `Response.redirect`: the Set-Cookie header written
 * directly (`res.headers.append('set-cookie', …)`) or through a cookie
 * helper (`setCookie(res.headers, …)`).
 */
const redirectCookieMutationRegex =
	/\b(?:const|let|var)\s+(\w+)\s*=\s*Response\.redirect[\s\S]*?(?:setCookie\(\s*\1\.headers|\1\.headers\.(?:set|append)\(\s*["'`][Ss]et-[Cc]ookie["'`])/;

/** Any other header changed on a `Response.redirect` (Set-Cookie is the cookie rule's). */
const redirectHeaderMutationRegex =
	/\b(?:const|let|var)\s+(\w+)\s*=\s*Response\.redirect[\s\S]*?\1\.headers\.(?:set|append|delete)\(\s*(?!["'`][Ss]et-[Cc]ookie["'`])/;

// URL query parameters defined by external protocols we do not control are
// exempt from the camelCase casing standard (AGENTS.md §10).
const externalProtocolQueryParams = new Set([
	'error_description' // OAuth 2.0 / OpenID Connect error responses
]);

const snakeCaseQueryParamRegex = /\.searchParams\.get\(\s*["']([a-z0-9]+_[a-z0-9_]+)["']\s*\)/g;
/** Language and API conventions (AGENTS.md §6, §7, §10) for every source file. */
export function checkCodeStandards(file: SourceFile, { violation }: Reporter): void {
	const { relPath, content } = file;
	const script = file.scriptText();

	if (lintBypassRegex.test(content)) {
		violation(
			'lint-bypass-forbidden',
			relPath,
			'Compiler, linter and Svelte warning bypass pragmas (eslint-disable, @ts-ignore, @ts-expect-error, svelte-ignore, …) are forbidden; fix the code so it passes natively'
		);
	}

	if (script !== null && anyTypeRegex.test(script)) {
		violation(
			'any-type-forbidden',
			relPath,
			"'any' is forbidden (AGENTS.md §7). Use 'unknown' or a more specific type instead."
		);
	}

	if (script !== null && inlineDependencyRegex.test(script)) {
		violation(
			'inline-dependencies-forbidden',
			relPath,
			"Inline dependency specifiers ('npm:…', 'jsr:…', URLs) are forbidden in source code (AGENTS.md §7). Declare the dependency in package.json and import it by name."
		);
	}

	if (organizationZRegex.test(content)) {
		violation(
			'australian-spelling-violation',
			relPath,
			"BMuster is written in Australian English. Found 'organization' with a 'z'; spell it 'organisation'."
		);
	}

	if (script !== null && redirectCookieMutationRegex.test(script)) {
		violation(
			'redirect-cookie-mutation-forbidden',
			relPath,
			'Setting cookies on a Response.redirect is forbidden: its headers are immutable. Use event.cookies and redirect() from @sveltejs/kit instead.'
		);
	}

	if (script !== null && redirectHeaderMutationRegex.test(script)) {
		violation(
			'redirect-header-mutation-forbidden',
			relPath,
			'Modifying headers on a Response.redirect is forbidden: its headers are immutable. Use redirect() from @sveltejs/kit or construct a Response with a Location header.'
		);
	}

	if (script !== null && /\bawait\s+import\(\s*["']\.\.?\//.test(script)) {
		violation(
			'relative-dynamic-import-forbidden',
			relPath,
			"Relative dynamic imports (`await import('./file.ts')`) are forbidden (AGENTS.md §7); use static top-level imports (`#lib/…`)."
		);
	}

	if (script !== null) {
		for (const match of script.matchAll(snakeCaseQueryParamRegex)) {
			const name = match[1] ?? '';
			if (!externalProtocolQueryParams.has(name)) {
				violation(
					'snake-case-url-query-parameter-forbidden',
					relPath,
					`URL query parameter "${name}" is snake_case. BMuster's own query parameters are camelCase (AGENTS.md §10). If it is defined by an external protocol, add it to externalProtocolQueryParams in scripts/hygiene/code-standards.ts.`
				);
			}
		}
	}

	checkUnescapedHtml(file, violation);
	checkEachKeys(file, violation);
}

/** `{@html}` renders unescaped HTML: an XSS risk. */
function checkUnescapedHtml(file: SourceFile, violation: Reporter['violation']): void {
	const document = file.svelte();
	for (const tag of document?.htmlTags ?? []) {
		violation(
			'raw-html-forbidden',
			file.relPath,
			`Line ${file.lineAt(tag.start)}: {@html …} renders unescaped HTML (Cross-Site Scripting risk). Render the content with components instead.`
		);
	}
}

/** `{#each}` blocks are keyed (AGENTS.md §7), so rows keep their state when the list changes. */
function checkEachKeys(file: SourceFile, violation: Reporter['violation']): void {
	for (const block of file.svelte()?.eachBlocks ?? []) {
		if (block.key === undefined && block.context !== null) {
			violation(
				'each-block-key-required',
				file.relPath,
				`Line ${file.lineAt(block.start)}: {#each} has no key; write {#each items as item (item.id)}.`
			);
		}
	}
}
