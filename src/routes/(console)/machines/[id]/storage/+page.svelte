<script lang="ts">
	import { hasPermission } from '#lib/domain/access/access.ts';
	import { machinePresence } from '#lib/runes/machine-presence.svelte.ts';
	import { formatRelative } from '#lib/utils/format.ts';
	import MachineUnreachable from '../machine-unreachable.svelte';
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
	// The machine page's one live status (SPEC-PRESENCE P10): the folders open when it comes back.
	const presence = machinePresence();
	const status = $derived(presence.status);
</script>

{#if !hasPermission(data.grants, 'files')}
	<NoPermission />
{:else if status.kind !== 'online'}
	<MachineUnreachable
		{status}
		detail={data.reported.kind === 'reported'
			? `Its folders open when it is back. Last reported ${formatRelative(data.reported.reportedAt, data.now)}:`
			: 'Its folders open when it is back.'}
	/>
	{#if data.reported.kind === 'reported'}
		<DriveList drives={data.reported.drives} now={data.now} onopen={undefined} />
	{/if}
{:else}
	{#key machine.id}
		<StorageBrowser {machine} />
	{/key}
{/if}
