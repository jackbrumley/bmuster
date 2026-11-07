import type { ITheme } from '@xterm/xterm';

/**
 * The terminal on the page: xterm.js with fitting, clickable links and wide
 * characters (SPEC-SESSIONS T1). xterm.js only runs in a browser, so it is
 * loaded when the page mounts. Its colours come from the theme tokens, read
 * off a styled probe element, and follow the light and dark switch.
 */

export type Screen = {
	write(bytes: Uint8Array): void;
	reset(): void;
	focus(): void;
	/** As if typed (the extra keys): goes through `onData`. */
	input(data: string): void;
	/** Pastes text, bracketed when the program asked for it. */
	paste(text: string): void;
	selection(): string;
	applicationCursor(): boolean;
	/** Makes the text bigger or smaller; returns the new size. */
	zoom(step: 1 | -1): number;
	/** Fits the grid to the box; true when its size changed. */
	fit(): boolean;
	size(): { cols: number; rows: number };
	dispose(): void;
};

export type ScreenEvents = {
	onData(data: string): void;
	onResize(cols: number, rows: number): void;
	/** Ctrl+C or Ctrl+Shift+C with a selection (desktop copy). */
	onCopy(text: string): void;
};

const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22] as const;
const FONT_KEY = 'bmuster.terminal.fontSize';

function savedFontSize(fallback: number): number {
	try {
		const saved = Number(localStorage.getItem(FONT_KEY));
		return FONT_SIZES.some((size) => size === saved) ? saved : fallback;
	} catch {
		return fallback;
	}
}

function saveFontSize(size: number): void {
	try {
		localStorage.setItem(FONT_KEY, String(size));
	} catch {
		// A per-viewer convenience; nothing breaks without it.
	}
}

/** The terminal's colours from the theme tokens, as the browser resolved them. */
function themeFrom(probe: HTMLElement): ITheme {
	const style = getComputedStyle(probe);
	return {
		background: style.backgroundColor,
		foreground: style.color,
		cursor: style.borderTopColor,
		cursorAccent: style.backgroundColor,
		selectionBackground: style.outlineColor
	};
}

export async function createScreen(
	host: HTMLElement,
	probe: HTMLElement,
	events: ScreenEvents
): Promise<Screen> {
	const [{ Terminal }, { FitAddon }, { WebLinksAddon }, { Unicode11Addon }] = await Promise.all([
		import('@xterm/xterm'),
		import('@xterm/addon-fit'),
		import('@xterm/addon-web-links'),
		import('@xterm/addon-unicode11')
	]);
	const phone = window.matchMedia('(max-width: 899px)').matches;
	const terminal = new Terminal({
		allowProposedApi: true,
		cursorBlink: true,
		fontFamily: getComputedStyle(probe).fontFamily,
		fontSize: savedFontSize(phone ? 12 : 14),
		scrollback: 5000,
		theme: themeFrom(probe)
	});
	const fitAddon = new FitAddon();
	terminal.loadAddon(fitAddon);
	terminal.loadAddon(
		new WebLinksAddon((_event, uri) => {
			window.open(uri, '_blank', 'noopener,noreferrer');
		})
	);
	terminal.loadAddon(new Unicode11Addon());
	terminal.unicode.activeVersion = '11';
	terminal.open(host);
	// Copy and paste like Windows Terminal: Ctrl+C (or Ctrl+Shift+C) copies when
	// text is selected and sends ^C only when nothing is; Ctrl+V (or
	// Ctrl+Shift+V) is left to the browser, whose paste event xterm.js turns
	// into input, instead of sending ^V.
	terminal.attachCustomKeyEventHandler((event) => {
		if (event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) {
			return true;
		}
		const key = event.key.toLowerCase();
		if (key === 'c' && terminal.hasSelection()) {
			events.onCopy(terminal.getSelection());
			terminal.clearSelection();
			return false;
		}
		return key !== 'v';
	});
	const dataListener = terminal.onData((data) => {
		events.onData(data);
	});

	let size = { cols: terminal.cols, rows: terminal.rows };
	function fit(): boolean {
		if (host.clientWidth === 0 || host.clientHeight === 0) {
			return false;
		}
		fitAddon.fit();
		if (terminal.cols === size.cols && terminal.rows === size.rows) {
			return false;
		}
		size = { cols: terminal.cols, rows: terminal.rows };
		events.onResize(size.cols, size.rows);
		return true;
	}

	let fitTimer: ReturnType<typeof setTimeout> | undefined;
	const observer = new ResizeObserver(() => {
		clearTimeout(fitTimer);
		fitTimer = setTimeout(fit, 100);
	});
	observer.observe(host);

	const retheme = (): void => {
		terminal.options.theme = themeFrom(probe);
	};
	const themeWatch = new MutationObserver(retheme);
	themeWatch.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['data-theme']
	});
	const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
	darkQuery.addEventListener('change', retheme);

	fit();

	return {
		write: (bytes) => {
			terminal.write(bytes);
		},
		reset: () => {
			terminal.reset();
		},
		focus: () => {
			terminal.focus();
		},
		input: (data) => {
			terminal.input(data, true);
		},
		paste: (text) => {
			terminal.paste(text);
		},
		selection: () => terminal.getSelection(),
		applicationCursor: () => terminal.modes.applicationCursorKeysMode,
		zoom: (step) => {
			const current = FONT_SIZES.findIndex((value) => value >= (terminal.options.fontSize ?? 14));
			const next = FONT_SIZES[Math.min(FONT_SIZES.length - 1, Math.max(0, current + step))] ?? 14;
			terminal.options.fontSize = next;
			saveFontSize(next);
			fit();
			return next;
		},
		fit,
		size: () => ({ cols: terminal.cols, rows: terminal.rows }),
		dispose: () => {
			clearTimeout(fitTimer);
			observer.disconnect();
			themeWatch.disconnect();
			darkQuery.removeEventListener('change', retheme);
			dataListener.dispose();
			terminal.dispose();
		}
	};
}
