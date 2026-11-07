<script lang="ts">
	import { newNameProblem, type PathFlavour } from '#lib/domain/files/files.ts';
	import Button from '#lib/ui/button.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import TextField from '#lib/ui/text-field.svelte';

	/** Asks for a name: a new folder, or a new name for something (SPEC-FILES F7). */
	let {
		open,
		title,
		label,
		initial,
		saveLabel,
		flavour,
		onsave,
		onclose
	}: {
		open: boolean;
		title: string;
		label: string;
		initial: string;
		saveLabel: string;
		flavour: PathFlavour;
		/** Resolves with an error to show, or undefined once saved. */
		onsave: (name: string) => Promise<string | undefined>;
		onclose: () => void;
	} = $props();

	let name = $state('');
	let error = $state<string | undefined>(undefined);
	let saving = $state(false);

	$effect(() => {
		if (open) {
			name = initial;
			error = undefined;
		}
	});

	async function save(): Promise<void> {
		const trimmed = name.trim();
		error = newNameProblem(flavour, trimmed);
		if (error !== undefined || saving) {
			return;
		}
		saving = true;
		error = await onsave(trimmed);
		saving = false;
	}
</script>

<Modal {open} {title} {onclose}>
	<form
		onsubmit={(event) => {
			event.preventDefault();
			void save();
		}}
	>
		<TextField
			{label}
			name="name"
			type="text"
			autocomplete="off"
			autocapitalize="off"
			required={true}
			{error}
			bind:value={name}
		/>
	</form>
	{#snippet footer()}
		<Button variant="secondary" size="compact" type="button" onclick={onclose}>Cancel</Button>
		<Button
			variant="primary"
			size="compact"
			type="button"
			onclick={() => {
				void save();
			}}>{saving ? 'Saving…' : saveLabel}</Button
		>
	{/snippet}
</Modal>
