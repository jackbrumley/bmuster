<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { fade } from 'svelte/transition';
	import {
		IconAdjustmentsHorizontal,
		IconArrowsMinimize,
		IconEye,
		IconKeyboard,
		IconPlugConnectedX,
		IconPointer
	} from '@tabler/icons-svelte-runes';
	import type { DisplayChoice } from '#lib/domain/desktop/displays.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import ToolButton from './tool-button.svelte';

	/**
	 * The controls inside full screen (SPEC-DESKTOP 15): the page's own bar is
	 * outside the full-screen element, so this one floats at the top centre
	 * of the screen. It shows when the mouse comes near the top edge or a
	 * finger taps the screen, and hides after a few idle seconds. Every
	 * action gives the keyboard back to the screen, and the screen's input
	 * ignores events aimed at the bar (`screen-input.ts`).
	 */
	let {
		surface,
		mode,
		canSwitch,
		displays,
		display,
		ondisplay,
		settingsOpen,
		settings,
		keysOpen,
		keys,
		onexit,
		onswitch,
		onsettings,
		onkeys,
		ondisconnect
	}: {
		surface: HTMLElement;
		/** Undefined while no session runs: then only Exit shows. */
		mode: DesktopMode | undefined;
		/** The person may control, so they may change mode. */
		canSwitch: boolean;
		/** The screen picker's choices (All screens among them when offered); shown with more than one. */
		displays: readonly DisplayChoice[];
		display: string | null;
		ondisplay: (id: string) => void;
		settingsOpen: boolean;
		/** The picture settings, shown under the bar while open. */
		settings: Snippet;
		/** The Keys menu (control sessions only), shown under the bar while open. */
		keysOpen: boolean;
		keys: Snippet;
		onexit: () => void;
		onswitch: (mode: DesktopMode) => void;
		onsettings: () => void;
		onkeys: () => void;
		ondisconnect: () => void;
	} = $props();

	/** Idle time before the bar hides. */
	const HIDE_AFTER_MS = 3000;
	/** How close to the top edge the mouse brings the bar back. */
	const TOP_EDGE_PX = 56;

	let shown = $state(true);
	let hovering = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	const pinned = $derived(hovering || settingsOpen || keysOpen);

	function reveal(): void {
		shown = true;
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (!pinned) {
				shown = false;
			}
		}, HIDE_AFTER_MS);
	}

	/** Runs an action, then gives the keyboard back to the screen. */
	function act(action: () => void): () => void {
		return () => {
			action();
			surface.focus();
			reveal();
		};
	}

	onMount(() => {
		const onMove = (event: PointerEvent) => {
			if (event.pointerType === 'touch') {
				return;
			}
			if (event.clientY - surface.getBoundingClientRect().top <= TOP_EDGE_PX) {
				reveal();
			}
		};
		const onDown = (event: PointerEvent) => {
			if (event.pointerType === 'touch') {
				reveal();
			}
		};
		surface.addEventListener('pointermove', onMove);
		surface.addEventListener('pointerdown', onDown);
		reveal();
		return () => {
			clearTimeout(timer);
			surface.removeEventListener('pointermove', onMove);
			surface.removeEventListener('pointerdown', onDown);
		};
	});

	$effect(() => {
		// Closing the settings or leaving the bar starts the idle clock again.
		if (!pinned) {
			reveal();
		}
	});
</script>

{#if shown || pinned}
	<div
		class="float"
		role="presentation"
		transition:fade={{ duration: 150 }}
		onpointerenter={() => (hovering = true)}
		onpointerleave={() => (hovering = false)}
	>
		<div class="bar" role="group" aria-label="Full screen controls">
			<ToolButton label="Leave full screen" pressed={undefined} disabled={false} onclick={onexit}>
				<IconArrowsMinimize size={20} />
			</ToolButton>
			{#if mode !== undefined}
				<span class="mode">{mode === 'control' ? 'Control' : 'View only'}</span>
				{#if canSwitch}
					{#if mode === 'watch'}
						<ToolButton
							label="Take control (reconnects)"
							pressed={undefined}
							disabled={false}
							onclick={act(() => {
								onswitch('control');
							})}
						>
							<IconPointer size={20} />
						</ToolButton>
					{:else}
						<ToolButton
							label="Switch to view only (reconnects)"
							pressed={undefined}
							disabled={false}
							onclick={act(() => {
								onswitch('watch');
							})}
						>
							<IconEye size={20} />
						</ToolButton>
					{/if}
				{/if}
				<ToolButton
					label="Picture settings"
					pressed={settingsOpen}
					disabled={false}
					onclick={act(onsettings)}
				>
					<IconAdjustmentsHorizontal size={20} />
				</ToolButton>
				{#if mode === 'control'}
					<ToolButton label="Keys" pressed={keysOpen} disabled={false} onclick={act(onkeys)}>
						<IconKeyboard size={20} />
					</ToolButton>
				{/if}
				<ToolButton label="Disconnect" pressed={undefined} disabled={false} onclick={ondisconnect}>
					<IconPlugConnectedX size={20} />
				</ToolButton>
			{/if}
		</div>
		{#if mode !== undefined && displays.length > 1}
			<div class="screens">
				<ChipGroup
					label="Screen"
					options={displays}
					bind:value={
						() => display,
						(value: string | null) => {
							if (value !== null) {
								act(() => {
									ondisplay(value);
								})();
							}
						}
					}
				/>
			</div>
		{/if}
		{#if settingsOpen && mode !== undefined}
			<div class="settings">{@render settings()}</div>
		{/if}
		{#if keysOpen && mode === 'control'}
			<div class="settings">{@render keys()}</div>
		{/if}
	</div>
{/if}

<style>
	.float {
		position: absolute;
		top: calc(var(--space-2) + var(--safe-top));
		left: 50%;
		z-index: 2;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2);
		width: max-content;
		max-width: calc(100% - 16px);
		max-height: calc(100% - 16px);
		transform: translateX(-50%);
	}

	.bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		max-width: 100%;
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-overlay);
	}

	.screens {
		max-width: 100%;
		padding: var(--space-1) var(--space-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-overlay);
	}

	.settings {
		width: min(440px, calc(100vw - 16px));
		min-height: 0;
		overflow: auto;
	}

	.mode {
		padding: 0 var(--space-2);
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		white-space: nowrap;
	}
</style>
