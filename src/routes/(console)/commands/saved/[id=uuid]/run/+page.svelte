<script lang="ts">
	import { page } from '$app/state';
	import { savedRunDraftSchema } from '#lib/schemas/commands/saved-commands.ts';
	import PageHeader from '#lib/ui/page-header.svelte';
	import RunSavedCommand from './run-saved-command.svelte';
	import type { PageProps } from './$types';

	/**
	 * Run a saved command (SPEC-SAVED-COMMANDS SC9–SC11). Machines picked on Machines arrive in page
	 * state and start ticked; they are only a starting point.
	 */
	let { data }: PageProps = $props();

	const draft = $derived(savedRunDraftSchema.safeParse(page.state.savedRunDraft));
</script>

<PageHeader
	title={data.command.name}
	summary="A saved command. Runs as Administrator (root or SYSTEM) on every machine you choose. Nothing runs until you confirm on Review."
	actions={undefined}
/>

{#key data.command.id}
	<RunSavedCommand
		command={data.command}
		machines={data.machines}
		ticked={draft.success ? draft.data.machineIds : []}
	/>
{/key}
