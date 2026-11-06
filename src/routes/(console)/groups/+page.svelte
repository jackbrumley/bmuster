<script lang="ts">
	import { IconDevices, IconPlus, IconUsers } from '@tabler/icons-svelte-runes';
	import PageHeader from '#lib/ui/page-header.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let view = $state<'people' | 'machines'>('people');

	function membersOf(groupId: string): string[] {
		return data.users
			.filter((user) => user.userGroupIds.includes(groupId))
			.map((user) => user.name);
	}

	function machinesIn(machineIds: string[]): string[] {
		return data.machines
			.filter((machine) => machineIds.includes(machine.id))
			.map((machine) => machine.name);
	}
</script>

<PageHeader title="Groups" summary="Put people and machines into groups, then give groups access.">
	{#snippet actions()}
		<button type="button" class="primary"><IconPlus size={18} /> New group</button>
	{/snippet}
</PageHeader>

<div class="switch" role="group" aria-label="Group type">
	<button type="button" aria-pressed={view === 'people'} onclick={() => (view = 'people')}>
		<IconUsers size={18} /> People
	</button>
	<button type="button" aria-pressed={view === 'machines'} onclick={() => (view = 'machines')}>
		<IconDevices size={18} /> Machines
	</button>
</div>

<ul class="grid">
	{#if view === 'people'}
		{#each data.userGroups as group (group.id)}
			{@const members = membersOf(group.id)}
			<li class="card">
				<h2>{group.name}</h2>
				<p class="description">{group.description}</p>
				<p class="count">{members.length} {members.length === 1 ? 'person' : 'people'}</p>
				<p class="members">{members.join(', ')}</p>
			</li>
		{/each}
	{:else}
		{#each data.machineGroups as group (group.id)}
			{@const members = machinesIn(group.machineIds)}
			<li class="card">
				<h2>{group.name}</h2>
				<p class="description">{group.description}</p>
				<p class="count">{members.length} {members.length === 1 ? 'machine' : 'machines'}</p>
				<p class="members">{members.join(', ')}</p>
			</li>
		{/each}
	{/if}
</ul>

<style>
	.primary {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-4);
		border: none;
		border-radius: var(--radius-pill);
		background: var(--brand);
		color: var(--brand-contrast);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		cursor: pointer;
	}

	.switch {
		display: inline-flex;
		gap: var(--space-1);
		margin-bottom: var(--space-4);
		padding: var(--space-1);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
	}

	.switch button {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-4);
		border: none;
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		cursor: pointer;
	}

	.switch button[aria-pressed='true'] {
		background: var(--surface-elevated);
		color: var(--text);
		box-shadow: var(--shadow-card);
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
		gap: var(--space-4);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.card {
		display: grid;
		gap: var(--space-1);
		align-content: start;
		padding: var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-card);
	}

	h2 {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}

	.description {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.count {
		margin-top: var(--space-2);
		color: var(--brand);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
	}

	.members {
		color: var(--text-soft);
		font-size: var(--text-sm);
	}
</style>
