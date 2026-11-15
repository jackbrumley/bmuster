<script lang="ts">
	import { onMount } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { ResolvedPathname } from '$app/types';
	import { IconChecklist } from '@tabler/icons-svelte-runes';
	import {
		approvalId,
		machineNamesText,
		type ApprovalSummary
	} from '#lib/domain/commands/assistant-runs.ts';
	import { onLiveEvent } from '#lib/runes/live-events.svelte.ts';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { formatRelative } from '#lib/utils/format.ts';
	import type { PageProps } from './$types';

	/**
	 * Approvals (SPEC-MCP M26): AI assistants' requests waiting for this person's decision, commands
	 * and clean-ups (M54), newest first, kept current by the console's live channel. Each opens its
	 * approval card.
	 */
	let { data }: PageProps = $props();

	onMount(() =>
		onLiveEvent(() => {
			void refreshAll();
		})
	);

	function cardHref(request: ApprovalSummary): ResolvedPathname {
		switch (request.kind) {
			case 'command':
				return resolve('/(console)/commands/[id=uuid]', { id: request.runId });
			case 'clean-up':
				return resolve('/(console)/approvals/clean-ups/[id=uuid]', { id: request.requestId });
		}
	}
</script>

<PageHeader
	title="Approvals"
	summary="Commands AI assistants ask to run, and clean-ups they ask for. Nothing runs until a person approves it; a request expires after 10 minutes."
	actions={undefined}
/>

{#if data.requests.length === 0}
	<EmptyState
		icon={IconChecklist}
		title="Nothing is waiting for your approval."
		detail="When an AI assistant asks to run a command or clean up disk space and you may approve it, it appears here and you get a notice."
		children={undefined}
	/>
{:else}
	<ListCard
		heading={undefined}
		actions={undefined}
		label="Requests waiting for approval, newest first"
		items={data.requests}
		key={(request: ApprovalSummary) => approvalId(request)}
		empty="Nothing is waiting for your approval."
	>
		{#snippet row(request: ApprovalSummary)}
			<ListRow action={{ kind: 'link', href: cardHref(request) }} align="start" dimmed={false}>
				<span class="request">
					<span class="machines">{machineNamesText(request.machineNames)}</span>
					{#if request.kind === 'command'}
						<code class="command">{request.firstLine}</code>
					{:else}
						<span class="cleanup">Clean up {request.items} ({request.total})</span>
					{/if}
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

	.cleanup {
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.meta {
		color: var(--muted);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}
</style>
