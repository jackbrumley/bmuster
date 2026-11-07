<script lang="ts">
	/**
	 * The BMuster mark, "Radar ping" (static/brand/bmuster-logo.svg), drawn
	 * inline so it needs no request. At 32px and below it draws the simpler
	 * favicon version (static/favicon.svg): one ring, thicker strokes and no
	 * small dots, which would blur into specks at that size. Decorative: the
	 * wordmark beside it carries the name.
	 */
	let { size }: { size: number } = $props();

	const small = $derived(size <= 32);
	// Each viewBox is cropped to the tile's edges, so the tile fills the box.
</script>

<svg
	class="logo"
	width={size}
	height={size}
	viewBox={small ? '8 8 240 240' : '12 12 232 232'}
	aria-hidden="true"
>
	{#if small}
		<rect class="body" x="8" y="8" width="240" height="240" rx="48" />
		<circle class="ring" cx="128" cy="128" r="88" stroke-width="14" />
		<path class="sweep" d="M128 128 L128 40 A88 88 0 0 1 204 84 Z" />
		<path class="beam" d="M128 128 L204 84" stroke-width="20" />
		<circle class="lime" cx="128" cy="128" r="18" />
		<rect class="screen" x="150" y="144" width="56" height="42" rx="8" />
	{:else}
		<rect class="body" x="12" y="12" width="232" height="232" rx="44" />
		<circle class="ring" cx="128" cy="128" r="88" stroke-width="8" />
		<circle class="ring" cx="128" cy="128" r="56" stroke-width="8" />
		<path class="sweep" d="M128 128 L128 40 A88 88 0 0 1 204 84 Z" />
		<path class="beam" d="M128 128 L204 84" stroke-width="12" />
		<circle class="lime" cx="128" cy="128" r="12" />
		<rect class="screen" x="160" y="148" width="40" height="30" rx="6" />
		<circle class="lime" cx="84" cy="96" r="9" />
		<circle class="lime" cx="92" cy="176" r="9" />
	{/if}
</svg>

<style>
	.logo {
		flex-shrink: 0;
	}

	.body {
		fill: var(--logo-body);
	}

	.ring {
		fill: none;
		stroke: var(--logo-ring);
	}

	.sweep {
		fill: var(--logo-lime);
		opacity: 0.35;
	}

	.beam {
		stroke: var(--logo-lime);
		stroke-linecap: round;
	}

	.lime {
		fill: var(--logo-lime);
	}

	.screen {
		fill: var(--logo-screen);
	}
</style>
