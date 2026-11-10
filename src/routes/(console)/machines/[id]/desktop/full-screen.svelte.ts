/**
 * The desktop's full screen (SPEC-DESKTOP 15, SPEC-DESKTOP-FLOATING 10):
 * the browser's own full screen for the stage where it has one, and
 * otherwise (iPhone Safari has none for page elements) the stage filling
 * the window, with the page behind it unable to scroll. `on` means either
 * kind, so the page and its controls never need to tell them apart.
 */
export class FullScreen {
	/** The browser's own full screen holds the stage. */
	browser = $state(false);
	/** The stage covers the window instead. */
	filling = $state(false);
	readonly on = $derived(this.browser || this.filling);

	readonly #changed: () => void;
	#unlockScroll: (() => void) | undefined;

	/** `changed` runs after every change, once the new layout is drawn. */
	constructor(changed: () => void) {
		this.#changed = changed;
	}

	async toggle(stage: HTMLElement): Promise<void> {
		if (this.on) {
			await this.leave();
			return;
		}
		if (document.fullscreenEnabled) {
			try {
				await stage.requestFullscreen();
				return;
			} catch {
				// Refused or missing (some phone browsers): filling the window is the full screen there.
			}
		}
		this.#fill(true);
	}

	async leave(): Promise<void> {
		if (this.filling) {
			this.#fill(false);
		} else if (document.fullscreenElement !== null) {
			await document.exitFullscreen();
		}
	}

	/** Follows the browser entering and leaving its own full screen (Esc included). */
	attach(): () => void {
		const onChange = () => {
			this.browser = document.fullscreenElement !== null;
			this.#redraw();
		};
		document.addEventListener('fullscreenchange', onChange);
		return () => {
			document.removeEventListener('fullscreenchange', onChange);
			this.#fill(false);
		};
	}

	#fill(on: boolean): void {
		if (on === this.filling) {
			return;
		}
		this.filling = on;
		if (on) {
			const before = document.body.style.overflow;
			document.body.style.overflow = 'hidden';
			this.#unlockScroll = () => {
				document.body.style.overflow = before;
			};
		} else {
			this.#unlockScroll?.();
			this.#unlockScroll = undefined;
		}
		this.#redraw();
	}

	#redraw(): void {
		requestAnimationFrame(() => {
			this.#changed();
		});
	}
}
