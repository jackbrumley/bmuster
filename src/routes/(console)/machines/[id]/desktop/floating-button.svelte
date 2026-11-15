<script lang="ts">
	import { onMount } from 'svelte';
	import { IconClipboard, IconDownload, IconMenu2 } from '@tabler/icons-svelte-runes';
	import { BUTTON_SIZE, clampCorner, snapped, type FloatingPosition } from './floating-position.ts';
	import { PressDrag, type Point } from './press-drag.ts';
	import type { Attention } from './session-actions.ts';

	/**
	 * The round controls button over the screen (SPEC-DESKTOP-FLOATING): a
	 * finger or the mouse drags it anywhere and, let go, it snaps to the
	 * nearest edge. A tap opens the sheet, or on a wide screen expands the
	 * bar. A badge shows while something waits (FB6). It sits inside `area`,
	 * the screen less the safe-area insets, which its parent draws.
	 */
	let {
		element = $bindable(),
		position = $bindable(),
		area,
		attention,
		expanded,
		controls,
		ondragstart,
		onmoved,
		ontap
	}: {
		/** The button itself, for its owner to focus. */
		element: HTMLButtonElement | undefined;
		position: FloatingPosition;
		/** Where the button may sit; its parent's element. */
		area: HTMLElement | undefined;
		attention: Attention | undefined;
		/** What the button opens is open (`aria-expanded`). */
		expanded: boolean;
		/** The id of what it opens, while that is the sheet. */
		controls: string | undefined;
		ondragstart: () => void;
		/** A drag put the button somewhere new. */
		onmoved: () => void;
		/** A tap; `keyboard` when Enter or Space pressed it. */
		ontap: (keyboard: boolean) => void;
	} = $props();

	/** The button's top-left corner inside the area while it is dragged. */
	let drag = $state<Point>();

	const label = $derived(
		attention === undefined ? 'Session controls' : `Session controls, ${attention.text}`
	);

	function inArea(corner: Point): { corner: Point; box: DOMRect } | undefined {
		if (area === undefined) {
			return undefined;
		}
		const box = area.getBoundingClientRect();
		return {
			corner: clampCorner({ x: corner.x - box.left, y: corner.y - box.top }, box, BUTTON_SIZE),
			box
		};
	}

	const drags = new PressDrag({
		started: () => {
			ondragstart();
		},
		moved: (corner) => {
			drag = inArea(corner)?.corner;
		},
		dropped: (corner) => {
			const at = inArea(corner);
			drag = undefined;
			if (at !== undefined) {
				position = snapped(at.corner, at.box, BUTTON_SIZE);
				onmoved();
			}
		}
	});

	onMount(() => () => {
		drags.release();
	});
</script>

<button
	bind:this={element}
	data-raw-button="icon"
	type="button"
	class="fab edge-{position.edge}"
	class:dragging={drag !== undefined}
	style:--at={String(position.at)}
	style:--x={drag === undefined ? undefined : `${drag.x}px`}
	style:--y={drag === undefined ? undefined : `${drag.y}px`}
	aria-label={label}
	title={label}
	aria-expanded={expanded}
	aria-controls={controls}
	onpointerdown={(event: PointerEvent) => {
		if (element !== undefined) drags.down(event, element);
	}}
	onclick={(event: MouseEvent) => {
		if (drags.tapped()) ontap(event.detail === 0);
	}}
	><IconMenu2 size={24} />{#if attention !== undefined}<span class="badge" aria-hidden="true"
			>{#if attention.kind === 'files'}<IconDownload size={14} />{:else}<IconClipboard
					size={14}
				/>{/if}</span
		>{/if}</button
>

<style>
	.fab {
		--size: 48px;
		/* The button's place along its edge, as a share of the room it can travel. */
		--travel: calc(100% - var(--size));
		--along: calc(var(--travel) * var(--at));
		position: absolute;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: var(--size);
		height: var(--size);
		padding: 0;
		border: 2px solid var(--brand-contrast);
		border-radius: var(--radius-round);
		background: var(--brand);
		color: var(--brand-contrast);
		pointer-events: auto;
		touch-action: none;
		user-select: none;
		cursor: grab;
	}

	.fab.edge-left {
		top: var(--along);
		left: 0;
	}

	.fab.edge-right {
		top: var(--along);
		right: 0;
	}

	.fab.edge-top {
		top: 0;
		left: var(--along);
	}

	.fab.edge-bottom {
		bottom: 0;
		left: var(--along);
	}

	.fab.dragging {
		top: var(--y);
		right: auto;
		bottom: auto;
		left: var(--x);
		cursor: grabbing;
	}

	/* Something waits: files to download, or a clipboard notice. */
	.badge {
		position: absolute;
		top: -4px;
		right: -4px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		border: 2px solid var(--brand);
		border-radius: var(--radius-round);
		background: var(--brand-contrast);
		color: var(--brand);
	}
</style>
