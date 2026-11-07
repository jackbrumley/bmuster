import type { Report } from './report.ts';
import { isServerOnly, isTestFile, isUiSourceFile } from './source-file.ts';

/**
 * Destructive requests are confirmed first (AGENTS.md §12). A component or
 * browser module that sends a DELETE request, a `DELETE…` / `REVOKE…` action,
 * or submits a delete/remove/revoke form action (`action="?/delete"`) must
 * open the shared dialog (`confirmAction`) in the same file.
 *
 * A file whose request is confirmed elsewhere (a helper whose caller
 * confirms) is listed in DESTRUCTIVE_REQUEST_EXEMPTIONS with the reason.
 * Adding an entry is a reviewed change, never a way to skip a dialog.
 */
const DESTRUCTIVE_CONFIRMATION_RULE = 'destructive-request-confirmation';

/** Files that send a destructive request confirmed somewhere else. */
const DESTRUCTIVE_REQUEST_EXEMPTIONS: Readonly<Record<string, string>> = {};

const destructiveRequestRegex =
	/method:\s*["']DELETE["']|action:\s*["'](?:DELETE|REVOKE)[A-Z_]*["']|action=["'][^"']*\?\/(?:delete|remove|revoke)\w*["']|formaction=["'][^"']*\?\/(?:delete|remove|revoke)\w*["']/i;
/** Either shared confirmation: `confirmAction(` or the typed one, `confirmByTyping(`. */
const confirmationRegex = /\bconfirm(?:Action|ByTyping)\s*\(/;

/** The rule's message for a file, or null when it passes. */
function scanDestructiveConfirmation(relPath: string, text: string): string | null {
	if (!isUiSourceFile(relPath) || isServerOnly(relPath) || isTestFile(relPath)) return null;
	if (relPath in DESTRUCTIVE_REQUEST_EXEMPTIONS) return null;
	const request = destructiveRequestRegex.exec(text);
	if (!request || confirmationRegex.test(text)) return null;
	return `Sends a destructive request (${request[0]}) without confirmAction() or confirmByTyping(). Confirm it with the shared dialog, or, if a caller confirms it, list the file in DESTRUCTIVE_REQUEST_EXEMPTIONS (scripts/hygiene/destructive-confirmation.ts) with the reason.`;
}

export function checkDestructiveConfirmation(relPath: string, text: string, report: Report): void {
	const message = scanDestructiveConfirmation(relPath, text);
	if (message !== null) report(DESTRUCTIVE_CONFIRMATION_RULE, relPath, message);
}
