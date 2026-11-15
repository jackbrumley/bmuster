/**
 * Every desktop page catches files dragged or dropped anywhere on it
 * (SPEC-SESSION-FILES 3.1, SF14): a browser's own answer to a dropped file
 * is to open it in the tab, which would leave the session. The stage's drop
 * zone handles drops on the picture first and marks them handled; this
 * catches everything else.
 */

/** True when a drag carries files from the computer (rather than text or a link). */
function carriesFiles(event: DragEvent): boolean {
	return event.dataTransfer?.types.includes('Files') === true;
}

/** Text boxes keep taking dragged text; files are caught everywhere. */
function editable(target: EventTarget | null): boolean {
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		(target instanceof HTMLElement && target.isContentEditable)
	);
}

function caught(event: DragEvent): boolean {
	return !event.defaultPrevented && (carriesFiles(event) || !editable(event.target));
}

/**
 * Catches stray drags and drops at the window. `onstray` hears about files
 * dropped outside the drop zone (or where there is none), so the page can
 * say what to do instead.
 */
export function attachDropGuard(target: Window, onstray: (() => void) | undefined): () => void {
	const over = (event: DragEvent): void => {
		if (!caught(event)) {
			return;
		}
		event.preventDefault();
		if (event.dataTransfer !== null) {
			event.dataTransfer.dropEffect = 'none';
		}
	};
	const drop = (event: DragEvent): void => {
		if (!caught(event)) {
			return;
		}
		event.preventDefault();
		if (carriesFiles(event) && onstray !== undefined) {
			onstray();
		}
	};
	target.addEventListener('dragover', over);
	target.addEventListener('drop', drop);
	return () => {
		target.removeEventListener('dragover', over);
		target.removeEventListener('drop', drop);
	};
}

/** What the stage's drop zone tells its page (SPEC-SESSION-FILES 3.1). */
export type DropZoneHandlers = {
	/** Files are being dragged over the stage. */
	enter: () => void;
	/** The drag left the stage, was dropped, or Escape was pressed. */
	leave: () => void;
	/** Files were dropped on the stage. */
	drop: (transfer: DataTransfer) => void;
	/** Whether a drop would be taken (the drag's cursor shows copy or not). */
	accepting: () => boolean;
};

/**
 * Makes `stage` the drop zone: drags carrying files show the overlay, a drop
 * sends them. Events are marked handled, so the window's guard leaves them.
 * Pointer and keys reach the machine only through the stage's own input
 * handlers, which a drag does not trigger; Escape closes the overlay first.
 */
export function attachDropZone(stage: HTMLElement, handlers: DropZoneHandlers): () => void {
	let inside = false;
	const over = (event: DragEvent): void => {
		if (!carriesFiles(event)) {
			return;
		}
		event.preventDefault();
		if (event.dataTransfer !== null) {
			event.dataTransfer.dropEffect = handlers.accepting() ? 'copy' : 'none';
		}
		if (!inside) {
			inside = true;
			handlers.enter();
		}
	};
	const leaveStage = (event: DragEvent): void => {
		const to = event.relatedTarget;
		if (inside && !(to instanceof Node && stage.contains(to))) {
			inside = false;
			handlers.leave();
		}
	};
	const drop = (event: DragEvent): void => {
		if (!carriesFiles(event) || event.dataTransfer === null) {
			return;
		}
		event.preventDefault();
		inside = false;
		handlers.leave();
		handlers.drop(event.dataTransfer);
	};
	const key = (event: KeyboardEvent): void => {
		if (inside && event.key === 'Escape') {
			event.stopPropagation();
			inside = false;
			handlers.leave();
		}
	};
	stage.addEventListener('dragenter', over);
	stage.addEventListener('dragover', over);
	stage.addEventListener('dragleave', leaveStage);
	stage.addEventListener('drop', drop);
	window.addEventListener('keydown', key, true);
	return () => {
		stage.removeEventListener('dragenter', over);
		stage.removeEventListener('dragover', over);
		stage.removeEventListener('dragleave', leaveStage);
		stage.removeEventListener('drop', drop);
		window.removeEventListener('keydown', key, true);
	};
}
