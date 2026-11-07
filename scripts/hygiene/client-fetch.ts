import type { Report } from './report.ts';
import { isServerOnly, isTestFile, type SourceFile } from './source-file.ts';

/**
 * Browser code talks to the server through one client,
 * `src/lib/utils/api-client.ts` (AGENTS.md §6). It sets the headers, encodes
 * the body, parses the reply with its zod contract and turns network failures
 * into a result, so a change to any of that (session expiry, retries) is made
 * once.
 *
 * Server code (src/lib/server/**, `*.server.ts`, `+server.ts`), which calls
 * other services, is outside this rule, and so is the client itself.
 */
const CLIENT_FETCH_RULE = 'client-raw-fetch-forbidden';

const API_CLIENT_MODULE = 'src/lib/utils/api-client.ts';

const NETWORK_LAYER_FILES: ReadonlySet<string> = new Set([API_CLIENT_MODULE]);

/** A bare `fetch(` or a global one (`globalThis.fetch(`, `window.fetch(`). */
const RAW_FETCH = /(?<![\w$.])fetch\s*\(|\b(?:globalThis|window|self)\.fetch\s*\(/;

/** Whether the rule applies to a repo-relative path. */
function isClientFetchScanned(relPath: string): boolean {
	if (!relPath.startsWith('src/')) return false;
	if (!/\.(ts|js|svelte)$/.test(relPath)) return false;
	if (isTestFile(relPath) || NETWORK_LAYER_FILES.has(relPath)) return false;
	return !isServerOnly(relPath);
}

/** One-based line numbers that call `fetch` directly, ignoring comments. */
function findRawFetchLines(content: string): number[] {
	const lines: number[] = [];
	content.split('\n').forEach((line, index) => {
		const trimmed = line.trimStart();
		if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
		const code = line.replace(/\/\/.*$/, '');
		if (RAW_FETCH.test(code)) lines.push(index + 1);
	});
	return lines;
}

export function verifyClientFetch(files: readonly SourceFile[], report: Report): void {
	for (const file of files) {
		if (!isClientFetchScanned(file.relPath)) continue;
		const lines = file.isSvelte ? componentFetchLines(file) : findRawFetchLines(file.content);
		for (const line of lines) {
			report(
				CLIENT_FETCH_RULE,
				file.relPath,
				`Line ${line} calls fetch directly. Use the API client in ${API_CLIENT_MODULE}; outbound calls to other services belong in src/lib/server/.`
			);
		}
	}
}

/** Lines of a component's scripts and template (not its styles) that call fetch. */
function componentFetchLines(file: SourceFile): number[] {
	const document = file.svelte();
	if (!document) return [];
	const lines = new Set([
		...findRawFetchLines(document.script),
		...findRawFetchLines(document.markup)
	]);
	return [...lines].sort((a, b) => a - b);
}
