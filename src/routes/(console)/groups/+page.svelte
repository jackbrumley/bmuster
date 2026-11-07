<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { builtInGroupAbout } from '#lib/domain/access/access.ts';
	import ExportButton from '#lib/ui/export-button.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { describeRule } from '../access/rule-names.ts';
	import GroupSection from './group-section.svelte';
	import type { PageProps } from './$types';

	/** Groups of people and groups of machines (SPEC-ACCESS A1–A3, A8). */
	let { data }: PageProps = $props();

	const userGroups = $derived(
		data.userGroups.map((group) => ({
			id: group.id,
			name: group.name,
			description: group.description,
			about: undefined,
			membership: { kind: 'chosen' as const, memberIds: group.memberIds }
		}))
	);

	const machineGroups = $derived(
		data.machineGroups.map((group) => ({
			id: group.id,
			name: group.name,
			description: group.description,
			about: group.builtIn === 'none' ? undefined : builtInGroupAbout(group.builtIn),
			membership:
				group.membership.kind === 'all-machines'
					? { kind: 'all-machines' as const }
					: { kind: 'chosen' as const, memberIds: group.membership.machineIds }
		}))
	);

	/** `?machineGroup=<id>` opens that group (the Updates page links to Early updates this way). */
	const openedMachineGroup = $derived(page.url.searchParams.get('machineGroup') ?? undefined);

	function rulesUsing(groupId: string): string[] {
		return data.rules
			.filter((rule) => rule.userGroupId === groupId || rule.machineGroupId === groupId)
			.map((rule) => describeRule(rule, data.userGroups, data.machineGroups));
	}
</script>

<PageHeader
	title="Groups"
	summary="Put people and machines into groups, then give groups access with access rules."
>
	{#snippet actions()}
		<ExportButton href={resolve('/api/exports/groups')} />
	{/snippet}
</PageHeader>

<GroupSection
	kind="user"
	title="People"
	nouns={{ one: 'person', many: 'people' }}
	groups={userGroups}
	candidates={data.people}
	opened={undefined}
	{rulesUsing}
/>
<GroupSection
	kind="machine"
	title="Machines"
	nouns={{ one: 'machine', many: 'machines' }}
	groups={machineGroups}
	candidates={data.machines}
	opened={openedMachineGroup}
	{rulesUsing}
/>
