import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Report } from './report.ts';
import { repoPath, walkFiles } from './fs.ts';

/**
 * A cast through `unknown` (`value as unknown as Target`) tells the compiler
 * to stop checking: it converts anything into anything. Type the source
 * instead: a generic, a type guard, narrowing, a zod parse at a trust
 * boundary (JSON columns, request bodies, external payloads) or a corrected
 * declaration (AGENTS.md §7).
 *
 * Checked in application code, tests and scripts alike.
 */
const DOUBLE_CAST_RULE = 'double-cast-forbidden';

/** Folders the rule walks, relative to the repository root. */
const DOUBLE_CAST_ROOTS = ['src', 'tests', 'scripts'] as const;

const SCANNED_EXTENSIONS: ReadonlySet<string> = new Set(['.ts', '.js', '.mjs', '.svelte']);

/** `as unknown as`, also when a formatter breaks it across lines. */
const DOUBLE_CAST = /\bas\s+unknown\s+as\b/g;

/** One-based line numbers holding a cast through unknown, ignoring comments. */
function findDoubleCastLines(content: string): number[] {
	const lines = content.split('\n');
	const found = new Set<number>();
	for (const match of content.matchAll(DOUBLE_CAST)) {
		const line = content.slice(0, match.index).split('\n').length;
		const text = lines[line - 1] ?? '';
		const trimmed = text.trimStart();
		if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
		const comment = text.indexOf('//');
		const column = match.index - content.lastIndexOf('\n', match.index - 1) - 1;
		if (comment !== -1 && comment < column) continue;
		found.add(line);
	}
	return [...found].sort((a, b) => a - b);
}

/** Reports every cast through unknown under src/, tests/ and scripts/. */
export async function verifyNoDoubleCasts(workspaceRoot: string, report: Report): Promise<void> {
	for (const root of DOUBLE_CAST_ROOTS) {
		const paths = await walkFiles(join(workspaceRoot, root), { extensions: SCANNED_EXTENSIONS });
		for (const path of paths) {
			const lines = findDoubleCastLines(await readFile(path, 'utf8'));
			for (const line of lines) {
				report(
					DOUBLE_CAST_RULE,
					repoPath(workspaceRoot, path),
					`Line ${line} casts through unknown, which switches type checking off. Type the value properly instead: a generic, a type guard or narrowing, a zod parse at a trust boundary, or a corrected declaration.`
				);
			}
		}
	}
}
