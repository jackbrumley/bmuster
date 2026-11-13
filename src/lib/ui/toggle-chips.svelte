<script lang="ts" generics="T extends string">
	/**
	 * Pick any number of options as a row of pills, each on or off (`aria-pressed`), the chosen
	 * ones in the brand colour: the Machines page's select mode narrows by groups, systems and
	 * Online this way (SPEC-COMMANDS C2). ChipGroup is the pick-one version.
	 */
	let {
		label,
		options,
		selected = $bindable()
	}: {
		/** What the chips narrow, for screen readers. */
		label: string;
		options: readonly { value: T; label: string }[];
		selected: T[];
	} = $props();

	function toggle(value: T): void {
		selected = selected.includes(value)
			? selected.filter((chosen) => chosen !== value)
			: [...selected, value];
	}
</script>

<div class="chips" role="group" aria-label={label}>
	{#each options as option (option.value)}
		<button
			data-raw-button="chip"
			type="button"
			class="chip"
			aria-pressed={selected.includes(option.value)}
			onclick={() => {
				toggle(option.value);
			}}
		>
			{option.label}
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
</style>
