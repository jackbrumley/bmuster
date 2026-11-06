<script lang="ts">
	import { IconArrowRight, IconPlus } from '@tabler/icons-svelte-runes';
	import PageHeader from '#lib/ui/page-header.svelte';
	import PermissionChips from '#lib/ui/permission-chips.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	function nameOf(groups: { id: string; name: string }[], id: string): string {
		const group = groups.find((candidate) => candidate.id === id);
		if (group === undefined) {
			throw new Error(`Access rule points at a missing group: ${id}`);
		}
		return group.name;
	}
</script>

<PageHeader
	title="Access rules"
	summary="Each rule lets one group of people do certain things on one group of machines. Rules add up; nothing is denied."
>
	{#snippet actions()}
		<button type="button" class="primary"><IconPlus size={18} /> New rule</button>
	{/snippet}
</PageHeader>

<ul class="list">
	{#each data.rules as rule (rule.id)}
		<li class="rule">
			<p class="pair">
				<span class="who">{nameOf(data.userGroups, rule.userGroupId)}</span>
				<IconArrowRight size={16} />
				<span class="what">{nameOf(data.machineGroups, rule.machineGroupId)}</span>
			</p>
			<PermissionChips permissions={rule.permissions} />
			<p class="consent">
				{rule.consent === 'ask'
					? 'Asks the person at the screen first'
					: 'Connects without asking (unattended)'}
			</p>
		</li>
	{/each}
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

	.list {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		overflow: hidden;
	}

	.rule {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-4);
	}

	.rule + .rule {
		border-top: 1px solid var(--border);
	}

	.pair {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		color: var(--muted);
	}

	.who,
	.what {
		color: var(--text);
		font-weight: var(--weight-semibold);
	}

	.consent {
		color: var(--muted);
		font-size: var(--text-xs);
	}
</style>
