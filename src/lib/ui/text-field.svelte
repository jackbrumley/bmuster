<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	/**
	 * The standard single-line field (AGENTS.md §4, §12): a label above a box
	 * with 16px text, so iPhones do not zoom in when it is tapped.
	 */
	let {
		label,
		type,
		autocomplete,
		autocapitalize,
		required,
		value = $bindable()
	}: {
		label: string;
		type: 'text' | 'password' | 'email';
		autocomplete: HTMLInputAttributes['autocomplete'];
		autocapitalize: 'off' | 'sentences' | 'words';
		required: boolean;
		value: string;
	} = $props();
</script>

<label class="field">
	<span>{label}</span>
	<input {type} {autocomplete} {autocapitalize} {required} bind:value />
</label>

<style>
	.field {
		display: grid;
		gap: var(--space-1);
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}

	input {
		height: 48px;
		padding: 0 var(--space-3);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--surface);
		color: var(--text);
		font-size: var(--text-base);
	}
</style>
