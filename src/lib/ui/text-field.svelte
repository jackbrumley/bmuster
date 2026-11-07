<script lang="ts">
	import type { HTMLInputAttributes } from 'svelte/elements';

	/**
	 * The standard single-line field (AGENTS.md §4, §12): a label above a box
	 * with 16px text, so iPhones do not zoom in when it is tapped, and the
	 * field's error underneath it.
	 */
	let {
		label,
		name,
		type,
		autocomplete,
		autocapitalize,
		required,
		error,
		value = $bindable()
	}: {
		label: string;
		/** The form field name, for forms that post without JavaScript. */
		name: string;
		type: 'text' | 'password' | 'email' | 'url';
		autocomplete: HTMLInputAttributes['autocomplete'];
		autocapitalize: 'off' | 'sentences' | 'words';
		required: boolean;
		error: string | undefined;
		value: string;
	} = $props();

	const errorId = $props.id();
</script>

<label class="field">
	<span>{label}</span>
	<input
		{name}
		{type}
		{autocomplete}
		{autocapitalize}
		{required}
		aria-invalid={error !== undefined}
		aria-describedby={error !== undefined ? errorId : undefined}
		bind:value
	/>
	{#if error !== undefined}
		<span class="error" id={errorId}>{error}</span>
	{/if}
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

	input[aria-invalid='true'] {
		border-color: var(--danger);
	}

	.error {
		color: var(--danger);
		font-weight: var(--weight-regular);
	}
</style>
