<script lang="ts">
	import { resolve } from '$app/paths';
	import ExportButton from '#lib/ui/export-button.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import GroupSection from './group-section.svelte';
	import GroupsTabs from './groups-tabs.svelte';
	import { rulesUsing, userGroupRows } from './groups-view.ts';
	import type { PageProps } from './$types';

	/** Groups of people (SPEC-ACCESS A1, A3, A8): the People tab of Groups. */
	let { data }: PageProps = $props();

	const groups = $derived(userGroupRows(data));
</script>

<PageHeader
	title="Groups"
	summary="Put people and machines into groups, then give groups access with access rules."
>
	{#snippet actions()}
		<ExportButton href={resolve('/api/exports/groups')} />
	{/snippet}
</PageHeader>

<GroupsTabs />

<GroupSection
	kind="user"
	title="People"
	nouns={{ one: 'person', many: 'people' }}
	{groups}
	candidates={data.people}
	opened={undefined}
	rulesUsing={(groupId: string) => rulesUsing(data, groupId)}
/>
