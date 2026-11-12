/**
 * The window this tab popped the session out into (SPEC-DESKTOP-POPOUT 6,
 * 8). It remembers the window so a second Pop out focuses it, and checks
 * once a second whether it was closed, so the tab can offer the session
 * back. Nothing else is read from the other window.
 */
export class PopOutWindow {
	/** This tab opened a window for the session (until it takes the session back). */
	opened = $state(false);
	/** That window has been closed. */
	closed = $state(false);

	#window: Window | undefined;
	#watch: ReturnType<typeof setInterval> | undefined;

	/** Opens the window, or focuses it when it is still open; false when the browser blocked it. */
	open(url: string, name: string, features: string): boolean {
		if (this.#window !== undefined && !this.#window.closed) {
			this.#window.focus();
			return true;
		}
		const opened = window.open(url, name, features);
		if (opened === null) {
			return false;
		}
		this.#window = opened;
		this.opened = true;
		this.closed = false;
		this.#stopWatching();
		this.#watch = setInterval(() => {
			this.#check();
		}, 1000);
		return true;
	}

	focus(): void {
		this.#window?.focus();
	}

	close(): void {
		this.#window?.close();
		this.#check();
	}

	/** The session is back in this tab: the window is no longer its home. */
	forget(): void {
		this.#stopWatching();
		this.#window = undefined;
		this.opened = false;
		this.closed = false;
	}

	#check(): void {
		if (this.#window === undefined || this.#window.closed) {
			this.closed = true;
			this.#stopWatching();
		}
	}

	#stopWatching(): void {
		clearInterval(this.#watch);
		this.#watch = undefined;
	}
}
