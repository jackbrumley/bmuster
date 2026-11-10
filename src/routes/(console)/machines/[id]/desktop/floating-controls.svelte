<script lang="ts">
	import { onMount } from 'svelte';
	import {
		IconAdjustmentsHorizontal,
		IconArrowsMinimize,
		IconEye,
		IconHandFinger,
		IconMenu2,
		IconPlugConnectedX,
		IconPointer
	} from '@tabler/icons-svelte-runes';
	import type {
		DesktopSettings as PictureSettings,
		InputMessage
	} from '#lib/domain/desktop/messages.ts';
	import type { OsFamily } from '#lib/domain/machines/machine.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import DesktopSettings from './desktop-settings.svelte';
	import {
		clampCorner,
		DEFAULT_POSITION,
		DRAG_THRESHOLD_PX,
		readPosition,
		savePosition,
		snapped,
		type FloatingPosition
	} from './floating-position.ts';
	import type { TouchMode } from './input.ts';
	import KeyBar from './key-bar.svelte';
	import KeysMenu from './keys-menu.svelte';
	import ToolButton from './tool-button.svelte';

	/**
	 * Full screen on phones and tablets (SPEC-DESKTOP-FLOATING): one round
	 * button over the screen that a finger can drag anywhere; let go, it
	 * snaps to the nearer side edge and this browser remembers where. A tap
	 * opens a compact sheet beside it with the session's controls: the
	 * actions, the phone keys with the phone's keyboard, the Keys menu and
	 * the picture settings. The screen's input takes only events aimed at the
	 * screen itself (`screen-input.ts`), and a drag swallows its pointer's
	 * events on the way down, so neither the button nor the sheet ever
	 * clicks on the machine.
	 */
	let {
		osFamily,
		mode,
		canSwitch,
		touchMode,
		displays,
		display,
		settings,
		send,
		backToScreen,
		ontouchmode,
		ondisplay,
		onsettings,
		onswitch,
		onexit,
		ondisconnect
	}: {
		osFamily: OsFamily;
		/** Undefined while no session runs: then only Leave full screen shows. */
		mode: DesktopMode | undefined;
		/** The person may control, so they may change mode. */
		canSwitch: boolean;
		touchMode: TouchMode;
		/** The machine's displays; the picker shows when there is more than one. */
		displays: readonly { value: string; label: string; count: undefined }[];
		display: string | null;
		settings: PictureSettings;
		send: (message: InputMessage) => void;
		/** Gives the keyboard back to the screen after an action. */
		backToScreen: () => void;
		ontouchmode: (mode: TouchMode) => void;
		ondisplay: (id: string) => void;
		onsettings: (settings: PictureSettings) => void;
		onswitch: (mode: DesktopMode) => void;
		onexit: () => void;
		ondisconnect: () => void;
	} = $props();

	/** The button's size in page pixels (also in the stylesheet). */
	const SIZE = 48;

	const uid = $props.id();
	const control = $derived(mode === 'control');

	let position = $state<FloatingPosition>(DEFAULT_POSITION);
	/** The button's top-left corner inside the area while a finger drags it. */
	let drag = $state<{ x: number; y: number }>();
	let open = $state(false);
	let settingsOpen = $state(false);
	/** The phone's keyboard is open: the sheet folds to the key bar, at the top. */
	let typing = $state(false);
	let area = $state<HTMLElement>();
	let fab = $state<HTMLElement>();

	type Press = {
		id: number;
		startX: number;
		startY: number;
		dx: number;
		dy: number;
		moved: boolean;
	};
	let press: Press | undefined;
	/** The click that follows a drag's release is not a tap. */
	let afterDrag = false;

	function close(): void {
		open = false;
		typing = false;
		settingsOpen = false;
	}

	/** Runs an action from the sheet, then gives the keyboard back to the screen. */
	function act(action: () => void): () => void {
		return () => {
			action();
			backToScreen();
		};
	}

	/** Runs an action that ends the sheet's use (leave full screen, disconnect). */
	function leave(action: () => void): () => void {
		return () => {
			close();
			action();
		};
	}

	function cornerAt(event: PointerEvent, held: Press, box: DOMRect): { x: number; y: number } {
		return clampCorner(
			{ x: event.clientX - held.dx - box.left, y: event.clientY - held.dy - box.top },
			box,
			SIZE
		);
	}

	function onPointerDown(event: PointerEvent): void {
		afterDrag = false;
		if (fab === undefined || (event.pointerType === 'mouse' && event.button !== 0)) {
			return;
		}
		const box = fab.getBoundingClientRect();
		press = {
			id: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			dx: event.clientX - box.left,
			dy: event.clientY - box.top,
			moved: false
		};
		window.addEventListener('pointermove', onPointerMove, { capture: true });
		window.addEventListener('pointerup', onPointerUp, { capture: true });
		window.addEventListener('pointercancel', onPointerCancel, { capture: true });
	}

	/** The press this event's pointer started on the button, if any. */
	function pressOf(event: PointerEvent): Press | undefined {
		return press?.id === event.pointerId ? press : undefined;
	}

	function onPointerMove(event: PointerEvent): void {
		const held = pressOf(event);
		if (held === undefined || area === undefined) {
			return;
		}
		// The pointer belongs to the button until it is let go, wherever it goes.
		event.stopPropagation();
		if (
			!held.moved &&
			Math.hypot(event.clientX - held.startX, event.clientY - held.startY) <= DRAG_THRESHOLD_PX
		) {
			return;
		}
		if (!held.moved) {
			held.moved = true;
			close();
		}
		drag = cornerAt(event, held, area.getBoundingClientRect());
	}

	function onPointerUp(event: PointerEvent): void {
		const held = pressOf(event);
		if (held === undefined) {
			return;
		}
		event.stopPropagation();
		if (held.moved && area !== undefined) {
			const box = area.getBoundingClientRect();
			position = snapped(cornerAt(event, held, box), box, SIZE);
			savePosition(position);
			afterDrag = true;
		}
		release();
	}

	function onPointerCancel(event: PointerEvent): void {
		if (pressOf(event) !== undefined) {
			release();
		}
	}

	function release(): void {
		press = undefined;
		drag = undefined;
		window.removeEventListener('pointermove', onPointerMove, { capture: true });
		window.removeEventListener('pointerup', onPointerUp, { capture: true });
		window.removeEventListener('pointercancel', onPointerCancel, { capture: true });
	}

	function onTap(): void {
		if (afterDrag) {
			afterDrag = false;
			return;
		}
		if (open) {
			close();
		} else {
			open = true;
		}
	}

	onMount(() => {
		position = readPosition();
		return release;
	});
</script>

<div class="layer">
	{#if open}
		<button
			data-raw-button="backdrop"
			type="button"
			class="backdrop"
			aria-label="Close the controls"
			tabindex="-1"
			onclick={close}
		></button>
	{/if}
	<div
		class="area"
		bind:this={area}
		style:--at={String(position.at)}
		style:--rest={String(1 - position.at)}
	>
		<button
			bind:this={fab}
			data-raw-button="icon"
			type="button"
			class="fab"
			class:left={position.side === 'left'}
			class:dragging={drag !== undefined}
			style:--x={drag === undefined ? undefined : `${drag.x}px`}
			style:--y={drag === undefined ? undefined : `${drag.y}px`}
			aria-label="Session controls"
			title="Session controls"
			aria-expanded={open}
			aria-controls="{uid}-sheet"
			onpointerdown={onPointerDown}
			onclick={onTap}><IconMenu2 size={24} /></button
		>
		{#if open}
			<div
				id="{uid}-sheet"
				class="sheet"
				class:left={position.side === 'left'}
				class:above={!typing && position.at >= 0.5}
				class:typing
				role="group"
				aria-label="Session options"
			>
				{#if !typing}
					<Panel heading={undefined} actions={undefined} tone="normal" padding="normal">
						<div class="actions">
							{#if mode !== undefined}
								<span class="mode">{control ? 'Control' : 'View only'}</span>
								{#if control}
									<ToolButton
										label={touchMode === 'trackpad'
											? 'Touch input: trackpad. Switch to tapping where to click'
											: 'Touch input: tap where to click. Switch to trackpad'}
										pressed={undefined}
										disabled={false}
										onclick={act(() => {
											ontouchmode(touchMode === 'trackpad' ? 'touch' : 'trackpad');
										})}
									>
										{#if touchMode === 'trackpad'}
											<IconPointer size={20} />
										{:else}
											<IconHandFinger size={20} />
										{/if}
									</ToolButton>
								{/if}
								<ToolButton
									label="Picture settings"
									pressed={settingsOpen}
									disabled={false}
									onclick={act(() => (settingsOpen = !settingsOpen))}
								>
									<IconAdjustmentsHorizontal size={20} />
								</ToolButton>
								{#if canSwitch}
									<ToolButton
										label={control
											? 'Switch to view only (reconnects)'
											: 'Take control (reconnects)'}
										pressed={undefined}
										disabled={false}
										onclick={leave(() => {
											onswitch(control ? 'watch' : 'control');
										})}
									>
										{#if control}
											<IconEye size={20} />
										{:else}
											<IconPointer size={20} />
										{/if}
									</ToolButton>
								{/if}
							{/if}
							<ToolButton
								label="Leave full screen"
								pressed={undefined}
								disabled={false}
								onclick={leave(onexit)}
							>
								<IconArrowsMinimize size={20} />
							</ToolButton>
							{#if mode !== undefined}
								<ToolButton
									label="Disconnect"
									pressed={undefined}
									disabled={false}
									onclick={leave(ondisconnect)}
								>
									<IconPlugConnectedX size={20} />
								</ToolButton>
							{/if}
						</div>
						{#if mode !== undefined && displays.length > 1}
							<ChipGroup
								label="Screen"
								options={displays}
								bind:value={
									() => display,
									(value: string | null) => {
										if (value !== null) ondisplay(value);
									}
								}
							/>
						{/if}
					</Panel>
				{/if}
				{#if control}
					<Panel heading={undefined} actions={undefined} tone="normal" padding="normal">
						<KeyBar
							{osFamily}
							{send}
							onkeyboard={(keyboardOpen: boolean) => (typing = keyboardOpen)}
						/>
					</Panel>
				{/if}
				{#if control && !typing}
					<KeysMenu {osFamily} {send} afterSend={backToScreen} />
				{/if}
				{#if settingsOpen && mode !== undefined && !typing}
					<DesktopSettings {settings} onchange={onsettings} />
				{/if}
			</div>
		{/if}
	</div>
</div>

<style>
	.layer {
		position: absolute;
		inset: 0;
		z-index: 2;
		pointer-events: none;
	}

	.backdrop {
		position: absolute;
		inset: 0;
		padding: 0;
		border: 0;
		background: transparent;
		pointer-events: auto;
		cursor: default;
	}

	/* Where the button may sit: the screen less the safe-area insets and a small gap. */
	.area {
		--size: 48px;
		/* How far the button can travel down; --at and --rest (1 - at) come from the script. */
		--travel: calc(100% - var(--size));
		--button-top: calc(var(--travel) * var(--at));
		position: absolute;
		top: calc(var(--space-3) + var(--safe-top));
		right: calc(var(--space-3) + var(--safe-right));
		bottom: calc(var(--space-3) + var(--safe-bottom));
		left: calc(var(--space-3) + var(--safe-left));
		pointer-events: none;
	}

	.fab {
		position: absolute;
		top: var(--button-top);
		right: 0;
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

	.fab.left {
		right: auto;
		left: 0;
	}

	.fab.dragging {
		top: var(--y);
		right: auto;
		left: var(--x);
		cursor: grabbing;
	}

	/* Beside the button, below it in the top half of the screen and above it in the bottom half. */
	.sheet {
		position: absolute;
		top: calc(var(--button-top) + var(--size) + var(--space-2));
		right: 0;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: start;
		gap: var(--space-2);
		width: min(440px, 100%);
		max-height: min(50%, calc(var(--travel) * var(--rest) - var(--space-2)));
		overflow-y: auto;
		overscroll-behavior: contain;
		pointer-events: auto;
	}

	.sheet.left {
		right: auto;
		left: 0;
	}

	.sheet.above {
		top: auto;
		bottom: calc(var(--travel) * var(--rest) + var(--size) + var(--space-2));
		max-height: min(50%, calc(var(--button-top) - var(--space-2)));
	}

	/* Above the phone's keyboard, which rises from the bottom. */
	.sheet.typing {
		top: 0;
		bottom: auto;
		max-height: 50%;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.mode {
		margin-right: auto;
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		white-space: nowrap;
	}
</style>
