import { dirname, join, normalize } from 'node:path';
import { findImports } from './imports.ts';
import type { Report } from './report.ts';
import type { SourceFile } from './source-file.ts';

/**
 * Module boundaries (AGENTS.md §6).
 *
 * `server-imports-app-modules-forbidden`: code in src/lib/server/** stays
 * runnable from scripts and tests, outside Vite, so it never imports the
 * framework's virtual modules (`$app/*`, `$env/*`, `$service-worker`), which
 * only exist inside Vite. `@sveltejs/kit` itself is a plain package.
 */
const SERVER_APP_IMPORT_RULE = 'server-imports-app-modules-forbidden';

/**
 * `browser-imports-server-forbidden`: code the browser can load never imports
 * from src/lib/server/**, not even a type, so server modules stay out of the
 * bundle and a screen's shapes are declared where both sides can share them
 * (src/lib/domain/, or a contract in src/lib/schemas/). Server-only
 * files are src/lib/server/**, `*.server.ts` and `+server.ts`.
 */
const BROWSER_SERVER_IMPORT_RULE = 'browser-imports-server-forbidden';

/** Whether the browser can load this source file (tests and scripts are not app code). */
function browserReachable(relPath: string): boolean {
	if (!relPath.startsWith('src/')) return false;
	if (relPath.startsWith('src/lib/server/')) return false;
	if (relPath.endsWith('.test.ts')) return false;
	// Declaration files are never bundled; src/app.d.ts declares App.Locals,
	// which is server state by definition.
	if (relPath.endsWith('.d.ts')) return false;
	return !/(\.server\.ts|\+server\.ts)$/.test(relPath);
}

/** The reason browser-reachable code may not import `specifier`, or null when it may. */
function browserImportProblem(relPath: string, specifier: string): string | null {
	if (!browserReachable(relPath)) return null;
	const target = resolveLocalImport(relPath, specifier);
	if (target?.startsWith('src/lib/server/') !== true) return null;
	return `imports ${specifier} into code the browser loads. Declare the shape in src/lib/domain/<area>/ and import it from there on both sides; a helper only server code uses is named *.server.ts.`;
}

const VIRTUAL_MODULE = /^(\$app\/|\$env\/|\$service-worker$)/;

/** The reason a server module may not import `specifier`, or null when it may. */
function serverImportProblem(relPath: string, specifier: string, typeOnly: boolean): string | null {
	if (!relPath.startsWith('src/lib/server/') || typeOnly) return null;
	if (VIRTUAL_MODULE.test(specifier)) {
		return `imports ${specifier}; src/lib/server/** must run outside Vite (scripts, tests). Take what it needs as a parameter from the route or hook instead.`;
	}
	return null;
}

export function checkServerImports(file: SourceFile, report: Report): void {
	const script = file.scriptText();
	if (script === null) return;
	for (const { specifier, typeOnly, position } of findImports(file.relPath, script)) {
		const serverProblem = serverImportProblem(file.relPath, specifier, typeOnly);
		if (serverProblem !== null) {
			report(
				SERVER_APP_IMPORT_RULE,
				file.relPath,
				`Line ${file.lineAt(position)}: ${serverProblem}`
			);
		}
		const browserProblem = browserImportProblem(file.relPath, specifier);
		if (browserProblem !== null) {
			report(
				BROWSER_SERVER_IMPORT_RULE,
				file.relPath,
				`Line ${file.lineAt(position)}: ${browserProblem}`
			);
		}
	}
}

/** The repo-relative path an import resolves to, when it is a local file. */
export function resolveLocalImport(importerRelPath: string, specifier: string): string | null {
	for (const alias of ['#lib/', '$lib/']) {
		if (specifier.startsWith(alias)) {
			return normalize(`src/lib/${specifier.slice(alias.length)}`).replaceAll('\\', '/');
		}
	}
	if (specifier.startsWith('./') || specifier.startsWith('../')) {
		return normalize(join(dirname(importerRelPath), specifier)).replaceAll('\\', '/');
	}
	return null;
}
