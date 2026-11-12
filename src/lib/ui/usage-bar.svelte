<script lang="ts">
	/** A labelled bar for CPU, memory or disk use. Turns amber at 75% and red at 90%. */
	let { label, percent, detail }: { label: string; percent: number; detail: string } = $props();

	const level = $derived(percent >= 90 ? 'high' : percent >= 75 ? 'raised' : 'normal');
</script>

<div class="usage">
	<div class="row">
		<span class="label">{label}</span>
		<span class="detail">{detail}</span>
	</div>
	<div
		class="track"
		role="meter"
		aria-label={label}
		aria-valuenow={percent}
		aria-valuemin={0}
		aria-valuemax={100}
	>
		<div class="fill {level}" style:width="{percent}%"></div>
	</div>
</div>

<style>
	.usage {
		display: grid;
		/* A long drive name wraps instead of widening the card (SPEC-PHONE-LAYOUT U1). */
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-1);
	}

	.row {
		display: flex;
		justify-content: space-between;
		gap: var(--space-2);
		font-size: var(--text-xs);
	}

	.label {
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--text-soft);
		font-weight: var(--weight-medium);
	}

	.detail {
		flex-shrink: 0;
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}

	.track {
		height: 6px;
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		overflow: hidden;
	}

	.fill {
		height: 100%;
		border-radius: var(--radius-pill);
		background: var(--brand);
	}

	.fill.raised {
		background: var(--warning);
	}

	.fill.high {
		background: var(--danger);
	}
</style>
