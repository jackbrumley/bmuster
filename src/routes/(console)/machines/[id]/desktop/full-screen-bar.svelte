<script lang="ts">
	import { onMount } from 'svelte';
	import { fade } from 'svelte/transition';
	import { IconArrowsMinimize, IconX } from '@tabler/icons-svelte-runes';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import type { ChromeExit, SessionChrome } from './session-chrome.svelte.ts';
	import SessionPanels from './session-panels.svelte';
	import SessionTools from './session-tools.svelte';
	import ToolButton from './tool-button.svelte';

	/**
	 * The floating bar over the screen (SPEC-DESKTOP 15, 23), in full screen
	 * and in the pop-out window with a mouse: the page's bar is outside the
	 * full-screen element (or there is no page around the window), so this
	 * one floats at the top centre with the same tools (`session-tools.svelte`)
	 * and panels (`session-panels.svelte`). It shows when the mouse comes near
	 * the top edge or a finger taps the screen, and hides after a few idle
	 * seconds unless a panel is open. Every action gives the keyboard back to
	 * the screen, and the screen's input ignores events aimed at the bar
	 * (`screen-input.ts`).
	 */
	let { chrome, surface, exit }: { chrome: SessionChrome; surface: HTMLElement; exit: ChromeExit } =
		$props();

	/** Idle time before the bar hides. */
	const HIDE_AFTER_MS = 3000;
	/** How close to the top edge the mouse brings the bar back. */
	const TOP_EDGE_PX = 56;

	let shown = $state(true);
	let hovering = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	const pinned = $derived(hovering || chrome.panel !== 'none' || chrome.transfersOpen);
	const exitLabel = $derived(exit.kind === 'window' ? 'Close window' : 'Leave full screen');

	function reveal(): void {
		shown = true;
		clearTimeout(timer);
		timer = setTimeout(() => {
			if (!pinned) {
				shown = false;
			}
		}, HIDE_AFTER_MS);
	}

	/** After an action the keyboard goes back to the screen. */
	function after(): void {
		surface.focus();
		reveal();
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
		// Closing a panel or leaving the bar starts the idle clock again.
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
		<div
			class="bar"
			role="group"
			aria-label={exit.kind === 'window' ? 'Window controls' : 'Full screen controls'}
		>
			<ToolButton label={exitLabel} pressed={undefined} disabled={false} onclick={exit.run}>
				{#if exit.kind === 'window'}
					<IconX size={20} />
				{:else}
					<IconArrowsMinimize size={20} />
				{/if}
			</ToolButton>
			<SessionTools {chrome} look="overlay" {after} frame={undefined} />
		</div>
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
								after();
							}
						}
					}
				/>
			</div>
		{/if}
		{#if chrome.panel !== 'none' || chrome.transfersOpen}
			<div class="panels">
				<SessionPanels {chrome} />
			</div>
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

	.panels {
		display: grid;
		gap: var(--space-2);
		width: min(440px, calc(100vw - 16px));
		min-height: 0;
		overflow: auto;
	}
</style>
