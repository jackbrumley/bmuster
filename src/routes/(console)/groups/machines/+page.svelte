<script lang="ts">
	import { resolve } from '$app/paths';
	import ExportButton from '#lib/ui/export-button.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { page } from '$app/state';
	import GroupSection from '../group-section.svelte';
	import GroupsTabs from '../groups-tabs.svelte';
	import { machineGroupRows, rulesUsing } from '../groups-view.ts';
	import type { PageProps } from './$types';

	/** Groups of machines (SPEC-ACCESS A2, A3, A8): the Machines tab of Groups. */
	let { data }: PageProps = $props();

	const groups = $derived(machineGroupRows(data));

	/** `?machineGroup=<id>` opens that group (the Updates page links to Early updates this way). */
	const opened = $derived(page.url.searchParams.get('machineGroup') ?? undefined);
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
	kind="machine"
	title="Machines"
	nouns={{ one: 'machine', many: 'machines' }}
	{groups}
	candidates={data.machines}
	{opened}
	rulesUsing={(groupId: string) => rulesUsing(data, groupId)}
/>
