<script lang="ts">
	import { onMount } from 'svelte';
	import {
		IconArrowsMinimize,
		IconDeviceDesktop,
		IconEye,
		IconMenu2,
		IconPlugConnectedX,
		IconX
	} from '@tabler/icons-svelte-runes';
	import type {
		AutoLevel,
		DesktopSettings as PictureSettings,
		InputMessage
	} from '#lib/domain/desktop/messages.ts';
	import type { OsFamily } from '#lib/domain/machines/machine.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import Button from '#lib/ui/button.svelte';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import TabBar from '#lib/ui/tab-bar.svelte';
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
	import ClipboardPanel from './clipboard-panel.svelte';
	import type { DesktopClipboard } from './clipboard.svelte.ts';
	import KeyBar from './key-bar.svelte';
	import KeysMenu from './keys-menu.svelte';
	import { scrollEdges, sheetLayout } from './sheet-layout.ts';
	import type { TouchMode } from './touch-gestures.ts';
	import TouchInputChoice from './touch-input-choice.svelte';

	/**
	 * Full screen on phones and tablets (SPEC-DESKTOP-FLOATING, option A):
	 * one round button over the screen that a finger can drag anywhere; let
	 * go, it snaps to the nearest edge and this browser remembers where. A
	 * tap opens the sheet: a bottom sheet on an upright screen, a full-height
	 * side panel on a screen on its side, with tabs for the keys, the
	 * picture, the screen picker and the session, each scrolling inside the
	 * sheet with a fade where there is more. The screen's input takes only
	 * events aimed at the screen itself (`screen-input.ts`), and a drag
	 * swallows its pointer's events on the way down, so neither the button
	 * nor the sheet ever clicks on the machine.
	 */
	let {
		osFamily,
		mode,
		canSwitch,
		touchMode,
		displays,
		display,
		settings,
		autoLevel,
		agentVersion,
		send,
		clipboard,
		backToScreen,
		ontouchmode,
		ondisplay,
		onsettings,
		onswitch,
		exit,
		onexit,
		ondisconnect
	}: {
		osFamily: OsFamily;
		/** Undefined while no session runs: then only Leave full screen shows. */
		mode: DesktopMode | undefined;
		/** The person may control, so they may change mode. */
		canSwitch: boolean;
		touchMode: TouchMode;
		/** The machine's displays; the Screen tab shows when there is more than one. */
		displays: readonly { value: string; label: string; count: undefined }[];
		display: string | null;
		settings: PictureSettings;
		/** The level Auto picked, when it is on and the agent says. */
		autoLevel: AutoLevel | undefined;
		agentVersion: string;
		send: (message: InputMessage) => void;
		/** Copy and paste with the machine: the Clipboard tab, in a control session. */
		clipboard: DesktopClipboard;
		/** Gives the keyboard back to the screen after an action. */
		backToScreen: () => void;
		ontouchmode: (mode: TouchMode) => void;
		ondisplay: (id: string) => void;
		onsettings: (settings: PictureSettings) => void;
		onswitch: (mode: DesktopMode) => void;
		/** What the exit action leaves: full screen, or the pop-out window (SPEC-DESKTOP-POPOUT 9). */
		exit: 'full-screen' | 'window';
		onexit: () => void;
		ondisconnect: () => void;
	} = $props();

	/** The button's size in page pixels (also in the stylesheet). */
	const SIZE = 48;

	type Tab = 'keys' | 'clipboard' | 'picture' | 'screen' | 'session';

	const uid = $props.id();
	const control = $derived(mode === 'control');

	let position = $state<FloatingPosition>(DEFAULT_POSITION);
	/** The button's top-left corner inside the area while a finger drags it. */
	let drag = $state<{ x: number; y: number }>();
	let open = $state(false);
	/** The tab the person picked; until then, or once it goes away, the opening tab. */
	let chosen = $state<Tab>();
	/** The phone's keyboard is open: the sheet folds to the key bar, at the top. */
	let typing = $state(false);
	let area = $state<HTMLElement>();
	let areaWidth = $state(0);
	let areaHeight = $state(0);
	let fab = $state<HTMLElement>();
	let scroller = $state<HTMLElement>();
	/** More of the tab to see above or below: the fades show. */
	let edges = $state({ above: false, below: false });

	const tabs = $derived<{ value: Tab; label: string }[]>([
		...(control ? [{ value: 'keys' as const, label: 'Keys' }] : []),
		...(control ? [{ value: 'clipboard' as const, label: 'Clipboard' }] : []),
		...(mode !== undefined ? [{ value: 'picture' as const, label: 'Picture' }] : []),
		...(mode !== undefined && displays.length > 1
			? [{ value: 'screen' as const, label: 'Screen' }]
			: []),
		{ value: 'session', label: 'Session' }
	]);
	/** A control session opens on its keys; any other on the session's actions. */
	const shown = $derived<Tab>(
		chosen !== undefined && tabs.some((tab) => tab.value === chosen)
			? chosen
			: control
				? 'keys'
				: 'session'
	);
	const layout = $derived(sheetLayout({ width: areaWidth, height: areaHeight }, position, SIZE));

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
	}

	function pick(tab: Tab): void {
		chosen = tab;
		scroller?.scrollTo({ top: 0 });
	}

	/** Runs an action that ends the sheet's use (switch mode, leave full screen, disconnect). */
	function leave(action: () => void): () => void {
		return () => {
			close();
			action();
		};
	}

	function measure(): void {
		if (scroller instanceof HTMLElement) {
			edges = scrollEdges(scroller);
		}
	}

	/** Escape closes the open sheet, wherever the focus is, and leaves it on the button. */
	function onWindowKey(event: KeyboardEvent): void {
		if (open && event.key === 'Escape') {
			close();
			fab?.focus();
		}
	}

	// The fades follow the tab's content as it changes (More, another tab) and the sheet's size.
	$effect(() => {
		const box = scroller;
		// bind:this sets null, not undefined, when the sheet closes.
		if (!(box instanceof HTMLElement)) {
			return;
		}
		const observer = new ResizeObserver(measure);
		observer.observe(box);
		for (const child of box.children) {
			observer.observe(child);
		}
		measure();
		return () => {
			observer.disconnect();
		};
	});

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

<svelte:window onkeydown={onWindowKey} />

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
		bind:clientWidth={areaWidth}
		bind:clientHeight={areaHeight}
		style:--at={String(position.at)}
	>
		<button
			bind:this={fab}
			data-raw-button="icon"
			type="button"
			class="fab edge-{position.edge}"
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
				class="sheet {layout.kind}"
				class:right={layout.kind === 'side' && layout.side === 'right'}
				class:typing
				role="group"
				aria-label="Session options"
			>
				<Panel heading={undefined} actions={undefined} tone="normal" padding="none">
					<div class="inner">
						{#if !typing}
							<div class="tabs">
								<TabBar
									label="Session options"
									{tabs}
									panel="{uid}-tab"
									bind:value={() => shown, pick}
								/>
							</div>
						{/if}
						<div class="scroller">
							<div
								class="scroll"
								id="{uid}-tab"
								role="tabpanel"
								aria-label={tabs.find((tab) => tab.value === shown)?.label}
								bind:this={scroller}
								onscroll={measure}
							>
								<div class="content">
									{#if shown === 'keys' && control}
										<KeyBar
											{osFamily}
											{send}
											onkeyboard={(keyboardOpen: boolean) => (typing = keyboardOpen)}
										/>
										{#if !typing}
											<KeysMenu {osFamily} {send} afterSend={backToScreen} />
										{/if}
									{:else if shown === 'clipboard' && control}
										<ClipboardPanel {clipboard} />
									{:else if shown === 'picture' && mode !== undefined}
										<DesktopSettings {settings} {autoLevel} {agentVersion} onchange={onsettings} />
									{:else if shown === 'screen'}
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
									{:else if shown === 'session'}
										{#if mode !== undefined}
											<span class="mode">
												{#if control}
													<IconDeviceDesktop size={16} /> Control
												{:else}
													<IconEye size={16} /> View only
												{/if}
											</span>
										{/if}
										{#if control}
											<TouchInputChoice value={touchMode} onchange={ontouchmode} />
										{/if}
										<div class="actions">
											{#if mode !== undefined && canSwitch}
												<Button
													variant="secondary"
													size="compact"
													type="button"
													onclick={leave(() => {
														onswitch(control ? 'watch' : 'control');
													})}>{control ? 'Switch to view only' : 'Take control'}</Button
												>
											{/if}
											<Button
												variant="secondary"
												size="compact"
												type="button"
												onclick={leave(onexit)}
												>{#if exit === 'window'}<IconX size={18} /> Close window{:else}<IconArrowsMinimize
														size={18}
													/> Leave full screen{/if}</Button
											>
											{#if mode !== undefined}
												<Button
													variant="secondary"
													size="compact"
													type="button"
													onclick={leave(ondisconnect)}
													><IconPlugConnectedX size={18} /> Disconnect</Button
												>
											{/if}
										</div>
									{/if}
								</div>
							</div>
							{#if edges.above}
								<div class="fade top" aria-hidden="true"></div>
							{/if}
							{#if edges.below}
								<div class="fade bottom" aria-hidden="true"></div>
							{/if}
						</div>
					</div>
				</Panel>
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

	/* Where the button and the sheet may sit: the screen less the safe-area insets and a small gap. */
	.area {
		--size: 48px;
		/* The button's place along its edge; --at comes from the script. */
		--travel: calc(100% - var(--size));
		--along: calc(var(--travel) * var(--at));
		position: absolute;
		top: calc(var(--space-3) + var(--safe-top));
		right: calc(var(--space-3) + var(--safe-right));
		bottom: calc(var(--space-3) + var(--safe-bottom));
		left: calc(var(--space-3) + var(--safe-left));
		pointer-events: none;
	}

	.fab {
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

	/* An upright screen: a bottom sheet across the width, at most 70% of the height. */
	.sheet {
		position: absolute;
		right: 0;
		bottom: 0;
		left: 0;
		display: flex;
		flex-direction: column;
		max-height: 70%;
		pointer-events: auto;
	}

	/* A screen on its side: a full-height panel on the button's side. */
	.sheet.side {
		top: 0;
		right: auto;
		display: grid;
		grid-template-rows: minmax(0, 1fr);
		width: min(380px, 50%);
		max-height: none;
	}

	.sheet.side.right {
		right: 0;
		left: auto;
	}

	/* Above the phone's keyboard, which rises from the bottom. */
	.sheet.typing {
		top: 0;
		bottom: auto;
		display: flex;
		max-height: 50%;
	}

	.inner {
		display: grid;
		grid-template-rows: auto minmax(0, 1fr);
		min-height: 0;
	}

	.sheet.typing .inner {
		grid-template-rows: minmax(0, 1fr);
	}

	.tabs {
		padding: var(--space-3) var(--space-3) 0;
	}

	.scroller {
		position: relative;
		display: grid;
		grid-template-rows: minmax(0, 1fr);
		min-height: 0;
	}

	.scroll {
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.content {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: start;
		gap: var(--space-3);
		padding: var(--space-3);
	}

	/* There is more this way: the content fades out under the edge. */
	.fade {
		position: absolute;
		right: 0;
		left: 0;
		height: var(--space-8);
		pointer-events: none;
	}

	.fade.top {
		top: 0;
		background: linear-gradient(var(--surface-elevated), transparent);
	}

	.fade.bottom {
		bottom: 0;
		background: linear-gradient(transparent, var(--surface-elevated));
	}

	.mode {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		justify-self: start;
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
</style>
