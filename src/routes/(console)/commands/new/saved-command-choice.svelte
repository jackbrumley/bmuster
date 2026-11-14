<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { commandOsLabel } from '#lib/domain/commands/commands.ts';
	import { savedEffectLabel, type SavedCommandEntry } from '#lib/domain/commands/saved-commands.ts';
	import { savedCommandListSchema } from '#lib/schemas/commands/saved-commands.ts';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import LoadingVeil from '#lib/ui/loading-veil.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * Run command's other choice (SPEC-SAVED-COMMANDS SC9): the saved commands that can run on at
	 * least one machine of the selection. Picking one opens its run screen with the selection
	 * ticked (the machines it may run on).
	 */
	let { machineIds }: { machineIds: string[] } = $props();

	type Loaded =
		| { kind: 'loading' }
		| { kind: 'failed'; message: string }
		| { kind: 'ready'; commands: SavedCommandEntry[] };

	let loaded = $state<Loaded>({ kind: 'loading' });

	onMount(() => {
		void (async () => {
			const result = await apiRequest({
				method: 'GET',
				url: resolve('/api/commands/saved'),
				body: undefined,
				reply: savedCommandListSchema
			});
			loaded = result.ok
				? { kind: 'ready', commands: result.data.commands }
				: { kind: 'failed', message: result.message };
		})();
	});

	/** How many of the selection each command may run on. */
	function fits(command: SavedCommandEntry): number {
		return command.machineIds.filter((id) => machineIds.includes(id)).length;
	}

	const fitting = $derived(
		loaded.kind === 'ready'
			? loaded.commands.filter((command) => command.enabled && fits(command) > 0)
			: []
	);

	function open(command: SavedCommandEntry): void {
		void goto(resolve('/(console)/commands/saved/[id=uuid]/run', { id: command.id }), {
			state: { savedRunDraft: { machineIds } }
		});
	}
</script>

<LoadingVeil active={loaded.kind === 'loading'} title="Finding saved commands" detail={undefined}>
	{#if loaded.kind === 'failed'}
		<Notice tone="danger" title="The saved commands could not be read">
			<p>{loaded.message}</p>
		</Notice>
	{:else}
		<ListCard
			heading="Saved commands for these machines"
			actions={undefined}
			label="Saved commands for these machines"
			items={fitting}
			key={(command: SavedCommandEntry) => command.id}
			empty="No saved command can run on these machines."
		>
			{#snippet row(command: SavedCommandEntry)}
				<ListRow
					action={{
						kind: 'button',
						onclick: () => {
							open(command);
						}
					}}
					align="start"
					dimmed={false}
				>
					<span class="entry">
						<span class="name">{command.name}</span>
						<span class="description">{command.description}</span>
						<span class="meta" class:warn={command.effect === 'changes'}>
							{savedEffectLabel(command.effect)} · {command.systems
								.map(commandOsLabel)
								.join(' and ')}
							· runs on {fits(command)} of {machineIds.length} selected
						</span>
					</span>
				</ListRow>
			{/snippet}
		</ListCard>
	{/if}
</LoadingVeil>

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

	.description,
	.meta {
		color: var(--muted);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.meta {
		font-size: var(--text-xs);
	}

	.warn {
		color: var(--warning);
	}
</style>
