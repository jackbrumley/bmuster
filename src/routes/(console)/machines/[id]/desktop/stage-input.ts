import { readGranted } from '#lib/utils/clipboard.ts';
import { attachPasteShortcut } from './clipboard.svelte.ts';
import type { DesktopSession } from './desktop-session.svelte.ts';
import { attachScreenInput, type ScreenInputHost } from './screen-input.ts';

/**
 * Everything the viewer types, points and pastes on the stage goes to the session: the screen
 * input (mouse, keys, fingers) and the Ctrl+V paste shortcut (SPEC-DESKTOP 21). Shared by the
 * desktop tab, its pop-out window and a share link's guest page. Returns the detach function.
 */
export function attachStageInput(
	surface: HTMLElement,
	session: DesktopSession,
	host: Pick<ScreenInputHost, 'geometry' | 'touchMode' | 'zoom' | 'cursor'>
): () => void {
	const send = (message: Parameters<DesktopSession['input']>[0]) => {
		session.input(message);
	};
	const controlling = () => session.controlling;
	const detachInput = attachScreenInput(surface, { ...host, send, controlling });
	const detachPaste = attachPasteShortcut(surface, {
		clipboard: session.clipboard,
		send,
		controlling,
		readAllowed: readGranted
	});
	return () => {
		detachPaste();
		detachInput();
	};
}
