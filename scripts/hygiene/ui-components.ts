import type { Reporter } from './report.ts';
import { isServerOnly, isTestFile, isUiSourceFile, type SourceFile } from './source-file.ts';

/**
 * Standard feedback instead of browser dialogs (AGENTS.md §12): results are
 * toasts and destructive actions go through `confirmAction()`, never
 * `alert()`, `confirm()` or `prompt()`.
 *
 * Later, once the components exist: rules for the record modals (edit and
 * create modals keep unsaved-changes protection and check validity before
 * saving) and the data table (every table declares pagination).
 */
const browserDialogRegex =
	/(?<![.\w])(?:prompt|alert|confirm)\s*\(|\b(?:window|globalThis)\.(?:prompt|alert|confirm)\s*\(/g;

/** The code a component or module runs: scripts and template, without its styles. */
function codeText(file: SourceFile): string | null {
	if (file.isScript) return file.content;
	const document = file.svelte();
	if (!document) return null;
	const css = document.root.css;
	if (!css) return file.content;
	return (
		file.content.slice(0, css.start) + ' '.repeat(css.end - css.start) + file.content.slice(css.end)
	);
}

export function checkUiComponents(file: SourceFile, { violation }: Reporter): void {
	const { relPath } = file;
	if (isTestFile(relPath) || isServerOnly(relPath) || !isUiSourceFile(relPath)) return;
	const code = codeText(file);
	if (code === null) return;
	const matches = code.match(browserDialogRegex);
	if (matches) {
		violation(
			'browser-native-dialog-forbidden',
			relPath,
			`Found browser-native dialog(s): ${matches.join(', ')}. Show a toast for results and use confirmAction() for anything destructive.`
		);
	}
}
