<script lang="ts" generics="T extends string">
	import ChipGroup from './chip-group.svelte';

	/**
	 * A labelled choice in a form (a role, a mode, on or off): the label above
	 * a ChipGroup. A `null` value shows nothing chosen yet, for a choice the
	 * person must make themselves.
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

	const chips = $derived(options.map((option) => ({ ...option, count: undefined })));
</script>

<div class="control">
	<span class="label">{label}</span>
	<ChipGroup {label} options={chips} bind:value />
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
</style>
