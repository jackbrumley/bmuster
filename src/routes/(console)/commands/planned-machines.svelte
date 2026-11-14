<script lang="ts">
	import { skipReasonLabel, type PlannedMachine } from '#lib/domain/commands/commands.ts';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';

	/**
	 * Review's machines (SPEC-COMMANDS C8, SPEC-SAVED-COMMANDS SC11): every machine that will run the
	 * command by name, then every one that will be skipped with its reason.
	 */
	let { machines }: { machines: PlannedMachine[] } = $props();

	const willRun = $derived(machines.filter((machine) => machine.plan.kind === 'runs'));
	const skipped = $derived(machines.filter((machine) => machine.plan.kind === 'skipped'));
</script>

<ListCard
	heading="Will run ({willRun.length})"
	actions={undefined}
	label="Will run"
	items={willRun}
	key={(machine: PlannedMachine) => machine.id}
	empty="No machine will run it now."
>
	{#snippet row(machine: PlannedMachine)}
		<ListRow action={{ kind: 'static' }} align="center" dimmed={false}>
			<span class="name">{machine.name}</span>
		</ListRow>
	{/snippet}
</ListCard>

{#if skipped.length > 0}
	<ListCard
		heading="Will be skipped ({skipped.length})"
		actions={undefined}
		label="Will be skipped"
		items={skipped}
		key={(machine: PlannedMachine) => machine.id}
		empty=""
	>
		{#snippet row(machine: PlannedMachine)}
			<ListRow action={{ kind: 'static' }} align="center" dimmed={true}>
				<span class="name">{machine.name}</span>
				<span class="reason">
					{machine.plan.kind === 'skipped' ? skipReasonLabel(machine.plan.reason) : ''}
				</span>
			</ListRow>
		{/snippet}
	</ListCard>
{/if}

<style>
	.name {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.reason {
		color: var(--muted);
		font-size: var(--text-xs);
		text-align: right;
	}
</style>
