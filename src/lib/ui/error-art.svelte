<script lang="ts">
	/**
	 * The error pages' picture, after the logo's radar ping. `empty`: the
	 * sweep goes round and finds nothing (a page or machine that isn't
	 * there, or one you may not see). `fault`: the rings break and the
	 * centre turns to a warning (the server's own problem). Decorative: the
	 * title beside it says what happened.
	 */
	let { kind }: { kind: 'empty' | 'fault' } = $props();
</script>

<svg class="art {kind}" width="96" height="96" viewBox="0 0 128 128" aria-hidden="true">
	{#if kind === 'empty'}
		<circle class="ring" cx="64" cy="64" r="56" />
		<circle class="ring" cx="64" cy="64" r="36" />
		<circle class="ring faint" cx="64" cy="64" r="16" />
		<path class="sweep" d="M64 64 L64 8 A56 56 0 0 1 112.5 36 Z" />
		<path class="beam" d="M64 64 L112.5 36" />
		<circle class="centre" cx="64" cy="64" r="6" />
	{:else}
		<path class="ring" d="M64 8 A56 56 0 0 1 120 64" />
		<path class="ring" d="M8 64 A56 56 0 0 1 40 13.4" />
		<path class="ring" d="M88 114.6 A56 56 0 0 1 12 85" />
		<path class="ring faint" d="M64 28 A36 36 0 0 1 100 64" />
		<path class="ring faint" d="M28 64 A36 36 0 0 0 64 100" />
		<circle class="warning" cx="64" cy="64" r="16" />
		<path class="mark" d="M64 56 L64 66" />
		<circle class="dot" cx="64" cy="72" r="2.5" />
	{/if}
</svg>

<style>
	.art {
		flex-shrink: 0;
	}

	.ring {
		fill: none;
		stroke: var(--border-strong);
		stroke-width: 2;
		stroke-linecap: round;
	}

	.faint {
		stroke: var(--border);
	}

	.sweep {
		fill: var(--brand);
		opacity: 0.18;
	}

	.beam {
		stroke: var(--brand);
		stroke-width: 3;
		stroke-linecap: round;
	}

	.centre {
		fill: var(--brand);
	}

	.warning {
		fill: var(--danger-bg);
		stroke: var(--danger);
		stroke-width: 2;
	}

	.mark {
		stroke: var(--danger);
		stroke-width: 3;
		stroke-linecap: round;
	}

	.dot {
		fill: var(--danger);
	}
</style>
