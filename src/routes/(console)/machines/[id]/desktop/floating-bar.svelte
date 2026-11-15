<script lang="ts">
	import { onMount } from 'svelte';
	import { IconArrowsMinimize, IconGripVertical, IconX } from '@tabler/icons-svelte-runes';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import {
		barAtGrip,
		barCorner,
		barPlaceAt,
		BUTTON_SIZE,
		buttonAtGrip,
		buttonCentre,
		nudged,
		type BarPlace,
		type FloatingPosition
	} from './floating-position.ts';
	import { PressDrag, type Point } from './press-drag.ts';
	import type { BarOpening } from './floating-memory.ts';
	import type { ChromeExit, SessionChrome } from './session-chrome.svelte.ts';
	import SessionPanels from './session-panels.svelte';
	import SessionTools from './session-tools.svelte';
	import ToolButton from './tool-button.svelte';

	/**
	 * The expanded floating controls over the screen (SPEC-DESKTOP-FLOATING
	 * FB2–FB5), in full screen and in the pop-out window: a handle, the
	 * session's tools (`session-tools.svelte`), Disconnect, and Leave full
	 * screen or Close window at the far right. The handle drags the bar
	 * anywhere on the screen, and a tap (or Enter, or Space) collapses it into
	 * the round button, which takes the grip's place; the arrow keys move it.
	 * The display picker and the open panel hang under the bar, or over it in
	 * the lower half of the screen. The bar stays inside the screen less the safe-area insets: its
	 * place is a share of the room it can move in, so the stylesheet keeps it
	 * inside when the window changes size.
	 */
	let {
		chrome,
		exit,
		touch,
		place = $bindable(),
		opened,
		onmoved,
		oncollapse
	}: {
		chrome: SessionChrome;
		exit: ChromeExit;
		/** A touch screen: the Keys panel adds the phone keys and the touch input choice. */
		touch: boolean;
		place: BarPlace;
		/** How the bar came to show: as this browser left it, or expanded from the button just now. */
		opened: BarOpening;
		/** A drag or the arrow keys put the bar somewhere new. */
		onmoved: () => void;
		/** The handle was tapped: the button goes to `button`; `keyboard` when a key did it. */
		oncollapse: (button: FloatingPosition, keyboard: boolean) => void;
	} = $props();

	/** How far one arrow key press moves the bar, and with Shift. */
	const STEP_PX = 16;
	const BIG_STEP_PX = 64;
	/** The gap between the bar and what hangs from it (`--space-2`). */
	const HANG_GAP_PX = 8;
	/** The button's area sits further in from the screen than the bar's (`--space-3` against `--space-2`). */
	const BUTTON_INSET_PX = 4;

	let area = $state<HTMLElement>();
	let float = $state<HTMLElement>();
	let handle = $state<HTMLButtonElement>();
	let areaWidth = $state(0);
	let areaHeight = $state(0);
	let barWidth = $state(0);
	let barHeight = $state(0);
	/** The bar's top-left corner inside the area while it is dragged. */
	let drag = $state<Point>();

	const exitLabel = $derived(exit.kind === 'window' ? 'Close window' : 'Leave full screen');
	const areaSize = $derived({ width: areaWidth, height: areaHeight });
	const barSize = $derived({ width: barWidth, height: barHeight });
	const corner = $derived(drag ?? barCorner(place, areaSize, barSize));
	/** The display picker and the open panel: under the bar in the top half, over it in the bottom half. */
	const below = $derived(corner.y + barHeight / 2 < areaHeight / 2);
	const onRight = $derived(corner.x + barWidth / 2 > areaWidth / 2);
	/** The room the hanging panels have, between the bar and the screen's edge. */
	const room = $derived(
		Math.max((below ? areaHeight - corner.y - barHeight : corner.y) - HANG_GAP_PX, 0)
	);
	const hanging = $derived(
		chrome.has('display') || chrome.panel !== 'none' || chrome.transfersOpen
	);

	/** The area's and the bar's sizes now, measured (the bound sizes follow a frame later). */
	function sizes(): { area: DOMRect; bar: DOMRect } | undefined {
		if (area === undefined || float === undefined) {
			return undefined;
		}
		return { area: area.getBoundingClientRect(), bar: float.getBoundingClientRect() };
	}

	/** The grip's centre inside the bar, measured. */
	function gripInBar(bar: DOMRect): Point | undefined {
		if (handle === undefined) {
			return undefined;
		}
		const grip = handle.getBoundingClientRect();
		return { x: grip.left - bar.left + grip.width / 2, y: grip.top - bar.top + grip.height / 2 };
	}

	/** The button's area: the bar's, less the button's extra inset on every side. */
	function buttonArea(barArea: DOMRect): { width: number; height: number } {
		return {
			width: barArea.width - 2 * BUTTON_INSET_PX,
			height: barArea.height - 2 * BUTTON_INSET_PX
		};
	}

	function placeOf(client: Point): BarPlace | undefined {
		const now = sizes();
		if (now === undefined) {
			return undefined;
		}
		return barPlaceAt(
			{ x: client.x - now.area.left, y: client.y - now.area.top },
			now.area,
			now.bar
		);
	}

	const drags = new PressDrag({
		started: () => undefined,
		moved: (client) => {
			const now = sizes();
			const at = placeOf(client);
			drag = now === undefined || at === undefined ? undefined : barCorner(at, now.area, now.bar);
		},
		dropped: (client) => {
			drag = undefined;
			const at = placeOf(client);
			if (at !== undefined) {
				place = at;
				onmoved();
			}
		}
	});

	/** The button takes the grip's place: centred on it, then snapped to the nearest edge (FB5). */
	function collapse(keyboard: boolean): void {
		const now = sizes();
		const grip = now === undefined ? undefined : gripInBar(now.bar);
		if (now === undefined || grip === undefined) {
			return;
		}
		const at = barCorner(place, now.area, now.bar);
		const centre = {
			x: at.x + grip.x - BUTTON_INSET_PX,
			y: at.y + grip.y - BUTTON_INSET_PX
		};
		oncollapse(buttonAtGrip(centre, buttonArea(now.area), BUTTON_SIZE), keyboard);
	}

	function onHandleKey(event: KeyboardEvent): void {
		const step = event.shiftKey ? BIG_STEP_PX : STEP_PX;
		const deltas: Record<string, Point> = {
			ArrowLeft: { x: -step, y: 0 },
			ArrowRight: { x: step, y: 0 },
			ArrowUp: { x: 0, y: -step },
			ArrowDown: { x: 0, y: step }
		};
		const delta = deltas[event.key];
		const now = sizes();
		if (delta === undefined || now === undefined) {
			return;
		}
		event.preventDefault();
		place = nudged(place, delta, now.area, now.bar);
		onmoved();
	}

	onMount(() => {
		// Expanded from the button: the bar opens with its grip on the button (FB5), and
		// the keyboard goes to the handle when a key pressed the button, else back to the screen.
		if (opened.kind === 'expanded') {
			const now = sizes();
			const grip = now === undefined ? undefined : gripInBar(now.bar);
			if (now !== undefined && grip !== undefined) {
				const centre = buttonCentre(opened.button, buttonArea(now.area), BUTTON_SIZE);
				place = barAtGrip(
					{ x: centre.x + BUTTON_INSET_PX, y: centre.y + BUTTON_INSET_PX },
					grip,
					now.area,
					now.bar
				);
				onmoved();
			}
			if (opened.keyboard) {
				handle?.focus();
			} else {
				chrome.focusScreen();
			}
		}
		return () => {
			drags.release();
		};
	});
</script>

<div class="area" bind:this={area} bind:clientWidth={areaWidth} bind:clientHeight={areaHeight}>
	<div
		class="float"
		class:dragging={drag !== undefined}
		bind:this={float}
		bind:offsetWidth={barWidth}
		bind:offsetHeight={barHeight}
		style:--x={String(place.x)}
		style:--y={String(place.y)}
		style:--left={drag === undefined ? undefined : `${drag.x}px`}
		style:--top={drag === undefined ? undefined : `${drag.y}px`}
	>
		<div
			class="bar"
			role="group"
			aria-label={exit.kind === 'window' ? 'Window controls' : 'Full screen controls'}
		>
			<button
				bind:this={handle}
				data-raw-button="icon"
				type="button"
				class="handle"
				aria-label="Collapse the controls"
				title="Drag to move, tap to collapse; the arrow keys move it"
				onpointerdown={(event: PointerEvent) => {
					if (float !== undefined) drags.down(event, float);
				}}
				onclick={(event: MouseEvent) => {
					if (drags.tapped()) collapse(event.detail === 0);
				}}
				onkeydown={onHandleKey}><IconGripVertical size={20} /></button
			>
			<SessionTools
				{chrome}
				look="overlay"
				after={() => {
					chrome.focusScreen();
				}}
				frame={undefined}
			/>
			<ToolButton label={exitLabel} pressed={undefined} disabled={false} onclick={exit.run}>
				{#if exit.kind === 'window'}
					<IconX size={20} />
				{:else}
					<IconArrowsMinimize size={20} />
				{/if}
			</ToolButton>
		</div>
		{#if hanging}
			<div
				class="hanging"
				class:above={!below}
				class:right={onRight}
				style:width="{Math.min(440, areaWidth)}px"
				style:max-height="{room}px"
			>
				{#if chrome.has('display')}
					<div class="screens">
						<ChipGroup
							label="Screen"
							options={chrome.displays}
							bind:value={
								() => chrome.display,
								(value: string | null) => {
									if (value !== null) {
										chrome.selectDisplay(value);
										chrome.focusScreen();
									}
								}
							}
						/>
					</div>
				{/if}
				<SessionPanels {chrome} {touch} />
			</div>
		{/if}
	</div>
</div>

<style>
	/* Where the bar may sit: the screen less the safe-area insets and a small gap. */
	.area {
		position: absolute;
		top: calc(var(--space-2) + var(--safe-top));
		right: calc(var(--space-2) + var(--safe-right));
		bottom: calc(var(--space-2) + var(--safe-bottom));
		left: calc(var(--space-2) + var(--safe-left));
		z-index: 2;
		pointer-events: none;
	}

	/* At --x, --y of the room it can move in: the same share of the area, less the same share of itself. */
	.float {
		position: absolute;
		top: calc(var(--y) * 100%);
		left: calc(var(--x) * 100%);
		width: max-content;
		max-width: 100%;
		transform: translate(calc(var(--x) * -100%), calc(var(--y) * -100%));
		pointer-events: auto;
	}

	.float.dragging {
		top: var(--top);
		left: var(--left);
		transform: none;
	}

	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-2) var(--space-1) var(--space-1);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-overlay);
	}

	.handle {
		display: inline-flex;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		padding: 0;
		border: 0;
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--muted);
		touch-action: none;
		user-select: none;
		cursor: grab;
	}

	.handle:hover {
		background: var(--surface-muted);
	}

	.float.dragging .handle {
		cursor: grabbing;
	}

	.hanging {
		position: absolute;
		top: calc(100% + var(--space-2));
		left: 0;
		display: grid;
		align-content: start;
		gap: var(--space-2);
		min-height: 0;
		overflow: auto;
	}

	.hanging.above {
		top: auto;
		bottom: calc(100% + var(--space-2));
		align-content: end;
	}

	.hanging.right {
		right: 0;
		left: auto;
	}

	.screens {
		justify-self: start;
		max-width: 100%;
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-overlay);
	}
</style>
