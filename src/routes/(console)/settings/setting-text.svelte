<script lang="ts">
	import Button from '#lib/ui/button.svelte';
	import TextField from '#lib/ui/text-field.svelte';

	/**
	 * A text setting (SPEC-JOIN J11): a box and Save. The value is checked on
	 * the server; its reason shows under the box.
	 */
	let {
		label,
		description,
		lines,
		value,
		save
	}: {
		label: string;
		description: string;
		lines: 'single' | 'multiline';
		/** The saved value. */
		value: string;
		/** Saves the text; the reason when the server refuses it. */
		save: (text: string) => Promise<{ kind: 'saved' } | { kind: 'refused'; message: string }>;
	} = $props();

	let draft = $derived(value);
	let error = $state<string | undefined>(undefined);

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const result = await save(draft);
		error = result.kind === 'refused' ? result.message : undefined;
	}
</script>

<form class="setting" onsubmit={submit}>
	<div class="text">
		<h3>{label}</h3>
		<p>{description}</p>
	</div>
	<TextField
		{label}
		name={label}
		type={lines === 'multiline' ? 'multiline' : 'text'}
		autocomplete="off"
		autocapitalize="sentences"
		required={false}
		{error}
		bind:value={draft}
	/>
	<div class="actions">
		<Button variant="secondary" size="compact" type="submit" onclick={undefined}>Save</Button>
	</div>
</form>

<style>
	.setting {
		display: grid;
		flex: 1;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
		min-width: 0;
	}

	h3 {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}

	.text p {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
	}
</style>
