<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IconBookmark, IconPlus } from '@tabler/icons-svelte-runes';
	import { commandOsLabel } from '#lib/domain/commands/commands.ts';
	import { savedEffectLabel, type SavedCommandEntry } from '#lib/domain/commands/saved-commands.ts';
	import Button from '#lib/ui/button.svelte';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import CommandsTabs from '../commands-tabs.svelte';
	import type { PageProps } from './$types';

	/**
	 * Commands → Saved commands (SPEC-SAVED-COMMANDS SC1): scripts an admin wrote once. Anyone who
	 * may run one opens its run screen; an admin opens its form, and adds new ones.
	 */
	let { data }: PageProps = $props();

	function href(command: SavedCommandEntry) {
		return data.canWrite
			? resolve('/(console)/commands/saved/[id=uuid]', { id: command.id })
			: resolve('/(console)/commands/saved/[id=uuid]/run', { id: command.id });
	}
</script>

{#snippet newCommand()}
	<Button
		variant="primary"
		size="compact"
		type="button"
		onclick={() => void goto(resolve('/(console)/commands/saved/new'))}
	>
		<IconPlus size={18} /> New saved command
	</Button>
{/snippet}

<PageHeader
	title="Commands"
	summary="Saved commands are scripts an admin wrote once. Pick one, fill it in, choose the machines, and run it."
	actions={data.canWrite ? newCommand : undefined}
/>

<CommandsTabs />

{#if data.commands.length === 0}
	<EmptyState
		icon={IconBookmark}
		title="No saved commands you can run."
		detail="An admin writes saved commands and chooses the machine groups each may run on."
		children={undefined}
	/>
{:else}
	<ListCard
		heading={undefined}
		actions={undefined}
		label="Saved commands"
		items={data.commands}
		key={(command: SavedCommandEntry) => command.id}
		empty="No saved commands."
	>
		{#snippet row(command: SavedCommandEntry)}
			<ListRow
				action={{ kind: 'link', href: href(command) }}
				align="start"
				dimmed={!command.enabled}
			>
				<span class="entry">
					<span class="name">{command.name}</span>
					<span class="description">{command.description}</span>
					<span class="tags">
						<span class="tag">{command.systems.map(commandOsLabel).join(' and ')}</span>
						<span class="tag" class:warn={command.effect === 'changes'}>
							{savedEffectLabel(command.effect)}
						</span>
						{#if !command.enabled}
							<span class="tag">Off</span>
						{/if}
						{#if command.aiUnattended}
							<span class="tag" class:warn={command.effect === 'changes'}>
								AI runs it without approval
							</span>
						{/if}
					</span>
				</span>
			</ListRow>
		{/snippet}
	</ListCard>
{/if}

<style>
	.entry {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}

	.name {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.description {
		color: var(--muted);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
	}

	.tag {
		padding: var(--space-0-5) var(--space-2);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
	}

	.warn {
		background: var(--warning-bg);
		color: var(--warning);
	}
</style>
