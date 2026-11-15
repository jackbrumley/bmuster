<script lang="ts">
	import type { LinkHealth, SessionStatus } from './session-actions.ts';

	/**
	 * The session's status on the bars and in the sheet. The frame rate sits
	 * above the speed, in two short lines that take little room across the
	 * bar; each figure has a box of a fixed width, in figures of one width,
	 * so the bar around them keeps its size as they change
	 * (SPEC-DESKTOP-FLOATING FB1). A dot beside them shows the link's health
	 * in colour, and says it in words to a screen reader and in its tooltip
	 * (FB12).
	 */
	let { status }: { status: SessionStatus } = $props();

	const HEALTH_WORDS: Record<LinkHealth, string> = {
		good: 'Connection: good',
		slow: 'Connection: slow',
		struggling: 'Connection: struggling'
	};
</script>

<span class="status" class:figures={status.kind === 'figures'} role="status"
	>{#if status.kind === 'figures'}<span
			class="dot {status.health}"
			role="img"
			aria-label={HEALTH_WORDS[status.health]}
			title={HEALTH_WORDS[status.health]}
		></span><span class="line"
			><span class="figure">{status.fps}</span> <span class="unit">fps</span></span
		>
		<span class="line"
			><span class="figure">{status.kilobytes}</span> <span class="unit">KB/s</span></span
		>{:else}{status.text}{/if}</span
>

<style>
	.status {
		color: var(--muted);
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
		line-height: 1.1;
		white-space: nowrap;
	}

	/* The dot, then two columns, figures then units, so both lines line up and keep one width. */
	.status.figures {
		display: inline-grid;
		grid-template-columns: auto 5ch auto;
		column-gap: var(--space-1);
		align-items: baseline;
	}

	.dot {
		grid-row: 1 / span 2;
		align-self: center;
		width: 8px;
		height: 8px;
		border-radius: var(--radius-round);
	}

	.dot.good {
		background: var(--success);
	}

	.dot.slow {
		background: var(--warning);
	}

	.dot.struggling {
		background: var(--danger);
	}

	.line {
		display: contents;
	}

	/* Up to 99999 (KB/s, about 100 MB/s) without moving. */
	.figure {
		text-align: end;
	}
</style>
