<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { IconDevices } from '@tabler/icons-svelte-runes';
	import { commandDraftSchema } from '#lib/schemas/commands/commands.ts';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import RunCommand from './run-command.svelte';

	/**
	 * Run command and Review (SPEC-COMMANDS C6–C10). The machines (and, to run again, the
	 * commands) arrive in page state from Machines or a results page; they are only a starting
	 * point: the server checks every machine again. A reload loses the state, so the page then
	 * points back to Machines.
	 */
	const draft = $derived(commandDraftSchema.safeParse(page.state.commandDraft));
</script>

<PageHeader
	title="Run command"
	summary="Runs as Administrator (root or SYSTEM) on every machine. Nothing runs until you confirm on Review."
	actions={undefined}
/>

{#if draft.success}
	<RunCommand draft={draft.data} />
{:else}
	<EmptyState
		icon={IconDevices}
		title="Pick the machines first."
		detail="On Machines, press Select, tick the machines, then Run command."
	>
		<a class="link" href={resolve('/(console)')}>Open Machines</a>
	</EmptyState>
{/if}

<style>
	.link {
		color: var(--brand);
		font-weight: var(--weight-semibold);
	}
</style>
