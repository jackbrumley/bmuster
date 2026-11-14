<script lang="ts">
	import { onMount } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IconChecklist } from '@tabler/icons-svelte-runes';
	import { machineNamesText, type ApprovalSummary } from '#lib/domain/commands/assistant-runs.ts';
	import { onLiveEvent } from '#lib/runes/live-events.svelte.ts';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { formatRelative } from '#lib/utils/format.ts';
	import type { PageProps } from './$types';

	/**
	 * Approvals (SPEC-MCP M26): AI assistants' requests waiting for this person's decision, newest
	 * first, kept current by the console's live channel. Each opens its approval card.
	 */
	let { data }: PageProps = $props();

	onMount(() =>
		onLiveEvent(() => {
			void refreshAll();
		})
	);
</script>

<PageHeader
	title="Approvals"
	summary="Commands AI assistants ask to run. Nothing runs until a person approves it; a request expires after 10 minutes."
	actions={undefined}
/>

{#if data.requests.length === 0}
	<EmptyState
		icon={IconChecklist}
		title="Nothing is waiting for your approval."
		detail="When an AI assistant asks to run a command you may approve, it appears here and you get a notice."
		children={undefined}
	/>
{:else}
	<ListCard
		heading={undefined}
		actions={undefined}
		label="Requests waiting for approval, newest first"
		items={data.requests}
		key={(request: ApprovalSummary) => request.runId}
		empty="Nothing is waiting for your approval."
	>
		{#snippet row(request: ApprovalSummary)}
			<ListRow
				action={{
					kind: 'link',
					href: resolve('/(console)/commands/[id=uuid]', { id: request.runId })
				}}
				align="start"
				dimmed={false}
			>
				<span class="request">
					<span class="machines">{machineNamesText(request.machineNames)}</span>
					<code class="command">{request.firstLine}</code>
					<span class="meta">
						{request.requestedBy} via {request.assistant} · {formatRelative(
							request.requestedIso,
							data.now
						)}
					</span>
				</span>
			</ListRow>
		{/snippet}
	</ListCard>
{/if}

<style>
	.request {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}

	.machines {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.command {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.meta {
		color: var(--muted);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}
</style>
