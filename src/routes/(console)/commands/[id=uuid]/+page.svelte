<script lang="ts">
	import PageHeader from '#lib/ui/page-header.svelte';
	import ApprovalCard from '../approval-card.svelte';
	import RunResults from './run-results.svelte';
	import type { PageProps } from './$types';

	/**
	 * A run's results page (SPEC-COMMANDS C16 to C18); it survives a reload: runs live on the
	 * server. An AI assistant's request waiting for this person's decision is its approval card
	 * instead (SPEC-MCP M28).
	 */
	let { data }: PageProps = $props();
</script>

{#if data.approval.kind === 'card'}
	<PageHeader
		title="Approve a command?"
		summary="An AI assistant asks to run this. Nothing runs until a person approves it. Read the command before you decide."
		actions={undefined}
	/>
	{#key data.approval.view.runId}
		<ApprovalCard view={data.approval.view} now={data.now} />
	{/key}
{:else}
	<PageHeader
		title="Command run"
		summary="One row per machine, updating as each finishes. Tap a machine to see its output."
		actions={undefined}
	/>
	{#key data.run.id}
		<RunResults initial={data.run} now={data.now} />
	{/key}
{/if}
