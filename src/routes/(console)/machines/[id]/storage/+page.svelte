<script lang="ts">
	import { IconPlugConnected } from '@tabler/icons-svelte-runes';
	import { hasPermission } from '#lib/domain/access/access.ts';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import { formatRelative } from '#lib/utils/format.ts';
	import NoPermission from '../no-permission.svelte';
	import DriveList from './drive-list.svelte';
	import StorageBrowser from './storage-browser.svelte';
	import type { PageProps } from './$types';

	/**
	 * The machine's Storage tab (SPEC-STORAGE 7), for people with the `files`
	 * permission. Offline, it shows the last per-drive summary the machine
	 * reported; the folders themselves stay on the machine.
	 */
	let { data }: PageProps = $props();

	const machine = $derived(data.machine);
</script>

{#if !hasPermission(data.grants, 'files')}
	<NoPermission />
{:else if machine.status.kind === 'offline'}
	<EmptyState
		icon={IconPlugConnected}
		title="This machine is offline."
		detail={data.reported.kind === 'reported'
			? `Its folders open when it checks in again. Last reported ${formatRelative(data.reported.reportedAt, data.now)}:`
			: 'Its folders open when it checks in again.'}
		children={undefined}
	/>
	{#if data.reported.kind === 'reported'}
		<DriveList drives={data.reported.drives} now={data.now} onopen={undefined} />
	{/if}
{:else}
	{#key machine.id}
		<StorageBrowser {machine} />
	{/key}
{/if}
