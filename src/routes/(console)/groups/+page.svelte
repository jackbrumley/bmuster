<script lang="ts">
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
			membership: { kind: 'chosen' as const, memberIds: group.memberIds }
		}))
	);

	const machineGroups = $derived(
		data.machineGroups.map((group) => ({
			id: group.id,
			name: group.name,
			description: group.description,
			membership:
				group.membership.kind === 'all-machines'
					? { kind: 'all-machines' as const }
					: { kind: 'chosen' as const, memberIds: group.membership.machineIds }
		}))
	);

	function rulesUsing(groupId: string): string[] {
		return data.rules
			.filter((rule) => rule.userGroupId === groupId || rule.machineGroupId === groupId)
			.map((rule) => describeRule(rule, data.userGroups, data.machineGroups));
	}
</script>

<PageHeader
	title="Groups"
	summary="Put people and machines into groups, then give groups access with access rules."
	actions={undefined}
/>

<GroupSection
	kind="user"
	title="People"
	nouns={{ one: 'person', many: 'people' }}
	groups={userGroups}
	candidates={data.people}
	{rulesUsing}
/>
<GroupSection
	kind="machine"
	title="Machines"
	nouns={{ one: 'machine', many: 'machines' }}
	groups={machineGroups}
	candidates={data.machines}
	{rulesUsing}
/>
