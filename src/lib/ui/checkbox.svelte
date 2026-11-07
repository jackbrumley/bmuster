<script lang="ts">
	/**
	 * The standard checkbox (AGENTS.md §12): a box and its label as one 40px
	 * touch target, with an error underneath when it must be ticked.
	 */
	let {
		label,
		error,
		checked = $bindable()
	}: { label: string; error: string | undefined; checked: boolean } = $props();

	const errorId = $props.id();
</script>

<div class="checkbox">
	<label>
		<input
			type="checkbox"
			aria-invalid={error !== undefined}
			aria-describedby={error !== undefined ? errorId : undefined}
			bind:checked
		/>
		<span>{label}</span>
	</label>
	{#if error !== undefined}
		<span class="error" id={errorId}>{error}</span>
	{/if}
</div>

<style>
	.checkbox {
		display: grid;
		gap: var(--space-1);
	}

	label {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 40px;
		color: var(--text);
		font-size: var(--text-base);
		font-weight: var(--weight-medium);
		cursor: pointer;
	}

	input {
		width: 20px;
		height: 20px;
		margin: 0;
		accent-color: var(--brand);
		cursor: pointer;
	}

	.error {
		color: var(--danger);
		font-size: var(--text-sm);
	}
</style>
