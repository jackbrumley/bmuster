/**
 * Calls `changed` once the screen element has settled at a new size: a
 * phone turned on its side, the browser's bars sliding away, the window
 * resized (SPEC-DESKTOP 20, Q2). A Fit picture is made for the size the
 * agent last heard, so without this a phone that turns after going full
 * screen keeps a picture made for the upright screen: soft, whatever the
 * quality. Sizes are read after `settleMs` so one turn sends one update.
 */
export function watchViewport(
	surface: HTMLElement,
	changed: () => void,
	settleMs = 300
): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const settle = () => {
		clearTimeout(timer);
		timer = setTimeout(changed, settleMs);
	};
	const observer = new ResizeObserver(settle);
	observer.observe(surface);
	window.addEventListener('resize', settle);
	return () => {
		clearTimeout(timer);
		observer.disconnect();
		window.removeEventListener('resize', settle);
	};
}
