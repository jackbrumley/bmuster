<script lang="ts" generics="T extends string">
	/**
	 * Pick one of a few options as a row of pills, the chosen one in the brand
	 * colour: list filters, the terminal's shell, the desktop's display, and
	 * (through SegmentedControl) form choices. Each option is its own button
	 * with `aria-pressed`. A `null` value shows nothing chosen yet. `count`
	 * adds a number after the label ("Online 3").
	 */
	let {
		label,
		options,
		value = $bindable()
	}: {
		/** What is being picked, for screen readers. */
		label: string;
		options: readonly { value: T; label: string; count: number | undefined }[];
		value: T | null;
	} = $props();
</script>

<div class="chips" role="group" aria-label={label}>
	{#each options as option (option.value)}
		<button
			data-raw-button="chip"
			type="button"
			class="chip"
			aria-pressed={value === option.value}
			onclick={() => (value = option.value)}
		>
			{option.label}
			{#if option.count !== undefined}
				<span class="count">{option.count}</span>
			{/if}
		</button>
	{/each}
</div>

<style>
	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 40px;
		padding: var(--space-2) var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-elevated);
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		overflow-wrap: anywhere;
		cursor: pointer;
	}

	.chip:hover {
		background: var(--surface-muted);
	}

	.chip[aria-pressed='true'] {
		border-color: var(--brand);
		background: var(--brand-tint);
		color: var(--brand);
	}

	.count {
		color: var(--muted);
		font-variant-numeric: tabular-nums;
	}
</style>
