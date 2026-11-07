<script lang="ts" generics="T extends string">
	/**
	 * Pick one of a few options (a role, a mode, on or off): a row of pills,
	 * the chosen one in the brand colour. Arrow keys are not needed; each
	 * option is its own button with `aria-pressed`. A `null` value shows
	 * nothing chosen yet, for a choice the person must make themselves.
	 */
	let {
		label,
		options,
		value = $bindable()
	}: {
		label: string;
		options: readonly { value: T; label: string }[];
		value: T | null;
	} = $props();
</script>

<div class="control">
	<span class="label">{label}</span>
	<div class="options" role="group" aria-label={label}>
		{#each options as option (option.value)}
			<button
				data-raw-button="segment"
				type="button"
				class="option"
				aria-pressed={value === option.value}
				onclick={() => (value = option.value)}
			>
				{option.label}
			</button>
		{/each}
	</div>
</div>

<style>
	.control {
		display: grid;
		gap: var(--space-1);
	}

	.label {
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}

	.options {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.option {
		min-height: 40px;
		padding: var(--space-2) var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface);
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		cursor: pointer;
	}

	.option[aria-pressed='true'] {
		border-color: var(--brand);
		background: var(--brand-tint);
		color: var(--brand);
	}
</style>
