/**
 * Copy text to the clipboard. When the browser refuses (no secure context, a
 * policy, or no recent click or key press), the result carries the browser's
 * own reason, so the message on screen says why.
 */
export type CopyResult = { ok: true } | { ok: false; reason: string };

export async function copyText(text: string): Promise<CopyResult> {
	if (!window.isSecureContext) {
		return { ok: false, reason: 'the page is not on HTTPS, so the clipboard is off' };
	}
	try {
		await navigator.clipboard.writeText(text);
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}
