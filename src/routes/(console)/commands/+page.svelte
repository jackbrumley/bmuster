<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconTerminal2 } from '@tabler/icons-svelte-runes';
	import {
		commandOsLabel,
		countsLine,
		runStatusLabel,
		type RunSummary
	} from '#lib/domain/commands/commands.ts';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { formatRelative } from '#lib/utils/format.ts';
	import type { PageProps } from './$types';

	/**
	 * The Commands tab (SPEC-COMMANDS C20): runs newest first, with who, when, the command's
	 * first line and how far each got. A new run starts from Machines (Select).
	 */
	let { data }: PageProps = $props();

	function commandText(run: RunSummary): string {
		return run.commands.length === 1
			? (run.commands[0]?.firstLine ?? '')
			: run.commands
					.map((command) => `${commandOsLabel(command.osFamily)}: ${command.firstLine}`)
					.join(' · ');
	}
</script>

<PageHeader
	title="Commands"
	summary="Commands run on many machines at once. Start one from Machines: Select, then Run command."
	actions={undefined}
/>

{#if data.runs.length === 0}
	<EmptyState
		icon={IconTerminal2}
		title="No commands run yet."
		detail="On Machines, press Select, tick the machines, then Run command."
		children={undefined}
	/>
{:else}
	<ListCard
		heading={undefined}
		actions={undefined}
		label="Command runs, newest first"
		items={data.runs}
		key={(run: RunSummary) => run.id}
		empty="No commands run yet."
	>
		{#snippet row(run: RunSummary)}
			<ListRow
				action={{ kind: 'link', href: resolve('/(console)/commands/[id=uuid]', { id: run.id }) }}
				align="start"
				dimmed={false}
			>
				<span class="run">
					<code class="command">{commandText(run)}</code>
					<span class="meta">
						{run.startedBy} · {formatRelative(run.startedIso, data.now)} · {runStatusLabel(
							run.status
						)}
					</span>
					<span class="counts">{countsLine(run.counts)}</span>
				</span>
			</ListRow>
		{/snippet}
	</ListCard>
{/if}

<style>
	.run {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}

	.command {
		overflow: hidden;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta,
	.counts {
		color: var(--muted);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}
</style>
