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

export type PasteResult = { ok: true; text: string } | { ok: false; reason: string };

/**
 * Reads this device's clipboard text. Call it only from a click or key press: browsers ask, or
 * refuse, otherwise. A refusal carries the browser's reason.
 */
export async function readText(): Promise<PasteResult> {
	if (!window.isSecureContext) {
		return { ok: false, reason: 'the page is not on HTTPS, so the clipboard is off' };
	}
	try {
		return { ok: true, text: await navigator.clipboard.readText() };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * A permission name TypeScript's list lacks (`clipboard-read`: Chromium knows it; Firefox and
 * Safari throw on it, which reads as not granted).
 */
function permissionName(name: string): PermissionName {
	return name as PermissionName;
}

/**
 * True when the browser already lets this page read the clipboard without asking (Chromium,
 * after the person allowed it once). Never asks; false wherever the browser cannot say.
 */
export async function readGranted(): Promise<boolean> {
	if (!window.isSecureContext) {
		return false;
	}
	try {
		const status = await navigator.permissions.query({ name: permissionName('clipboard-read') });
		return status.state === 'granted';
	} catch {
		return false;
	}
}
