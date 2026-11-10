<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fade } from 'svelte/transition';
	import RadarSpinner from './radar-spinner.svelte';

	/**
	 * The one loading overlay of the console (SPEC-LOADING): a soft, frosted
	 * fog over the block it wraps (a Panel, a ListCard, a page section), with
	 * a large radar, a title and an optional detail line ("Installing 0.4.5").
	 *
	 * - It shows only after 150 ms, so a quick load never flashes, and fades
	 *   out when `active` turns false.
	 * - The covered block is `aria-busy` and inert while active; the title is
	 *   the status the screen reader hears.
	 * - `children: undefined` is a block that has nothing to show until the
	 *   load ends (a folder being read): the veil is the whole block.
	 * - The veil and the block share one grid cell, so the block is at least
	 *   as tall as the veil's content and nothing shifts when it fades in.
	 * - `caption: 'hidden'` shows the radar alone, for a wait that needs no
	 *   words (the server updating). The title and detail stay the status a
	 *   screen reader hears; with nothing beneath, there is no fog either.
	 */
	let {
		active,
		title,
		detail,
		caption,
		children
	}: {
		active: boolean;
		title: string;
		detail: string | undefined;
		caption: 'shown' | 'hidden';
		children: Snippet | undefined;
	} = $props();

	const SHOW_AFTER_MS = 150;

	let shown = $state(false);

	$effect(() => {
		if (!active) {
			shown = false;
			return;
		}
		const timer = setTimeout(() => {
			shown = true;
		}, SHOW_AFTER_MS);
		return () => {
			clearTimeout(timer);
		};
	});
</script>

<div class="veiled" aria-busy={active && children !== undefined}>
	{#if children !== undefined}
		<div class="covered" inert={active}>{@render children()}</div>
	{/if}
	{#if active}
		<div
			class="veil"
			class:shown
			class:alone={children === undefined}
			class:bare={caption === 'hidden' && children === undefined}
			role="status"
			aria-live="polite"
			out:fade={{ duration: 240 }}
		>
			<span class="haze" aria-hidden="true"></span>
			<div class="message">
				<RadarSpinner size="large" />
				<p class="title" class:unseen={caption === 'hidden'}>{title}</p>
				{#if detail !== undefined}
					<p class="detail" class:unseen={caption === 'hidden'}>{detail}</p>
				{/if}
			</div>
		</div>
	{/if}
</div>

<style>
	.veiled {
		position: relative;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		min-width: 0;
	}

	.covered,
	.veil {
		grid-area: 1 / 1;
		min-width: 0;
	}

	.veil {
		position: relative;
		z-index: 2;
		display: grid;
		place-items: center;
		padding: var(--space-6) var(--space-4);
		overflow: hidden;
		border-radius: var(--radius-card);
		background: color-mix(in oklab, var(--surface-overlay) 58%, transparent);
		-webkit-backdrop-filter: blur(10px) saturate(1.2);
		backdrop-filter: blur(10px) saturate(1.2);
		opacity: 0;
		visibility: hidden;
		transition:
			opacity 0.32s ease-out,
			visibility 0s linear 0.32s;
	}

	.veil.shown {
		opacity: 1;
		visibility: visible;
		transition:
			opacity 0.32s ease-out,
			visibility 0s linear 0s;
	}

	/* With nothing beneath, the fog is the block: a quieter surface, no blur to show. */
	.veil.alone {
		background: color-mix(in oklab, var(--surface-muted) 55%, transparent);
	}

	/* The radar alone, on the page itself: no fog, room to breathe. */
	.veil.bare {
		padding: var(--space-12) var(--space-4);
		background: none;
		-webkit-backdrop-filter: none;
		backdrop-filter: none;
	}

	.veil.bare .haze {
		display: none;
	}

	/* Heard by screen readers, not shown. */
	.unseen {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	/*
	 * Two soft clouds (brand and surface) drift slowly across the fog, so a
	 * long wait still looks alive without anything flashing.
	 */
	.haze {
		position: absolute;
		inset: -30%;
		background:
			radial-gradient(
				circle at 30% 35%,
				color-mix(in oklab, var(--brand) 14%, transparent) 0%,
				transparent 40%
			),
			radial-gradient(
				circle at 70% 65%,
				color-mix(in oklab, var(--surface-overlay) 70%, transparent) 0%,
				transparent 45%
			),
			radial-gradient(
				circle at 55% 25%,
				color-mix(in oklab, var(--muted) 10%, transparent) 0%,
				transparent 35%
			);
		filter: blur(12px);
		pointer-events: none;
		animation: veil-drift 16s ease-in-out infinite alternate;
	}

	.message {
		position: relative;
		display: grid;
		justify-items: center;
		gap: var(--space-3);
		max-width: 36ch;
		text-align: center;
	}

	.title {
		margin: 0;
		color: var(--text);
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}

	.detail {
		margin: calc(-1 * var(--space-2)) 0 0;
		color: var(--text-soft);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	@keyframes veil-drift {
		0% {
			transform: translate(-6%, -4%) rotate(0deg) scale(1);
		}

		50% {
			transform: translate(5%, 3%) rotate(8deg) scale(1.08);
		}

		100% {
			transform: translate(-2%, 6%) rotate(-6deg) scale(1.02);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.haze {
			animation: none;
		}

		.veil,
		.veil.shown {
			transition: none;
		}
	}
</style>
