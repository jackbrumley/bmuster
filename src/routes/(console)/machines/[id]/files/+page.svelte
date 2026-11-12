<script lang="ts">
	import { hasPermission } from '#lib/domain/access/access.ts';
	import { machinePresence } from '#lib/runes/machine-presence.svelte.ts';
	import MachineUnreachable from '../machine-unreachable.svelte';
	import NoPermission from '../no-permission.svelte';
	import FileBrowser from './file-browser.svelte';
	import type { PageProps } from './$types';

	/** The machine's Files tab (SPEC-FILES), for people with the `files` permission (F1, F11). */
	let { data }: PageProps = $props();

	const machine = $derived(data.machine);
	// The machine page's one live status (SPEC-PRESENCE P10): Files opens when it comes back.
	const presence = machinePresence();
	const status = $derived(presence.status);
</script>

{#if !hasPermission(data.grants, 'files')}
	<NoPermission />
{:else if status.kind !== 'online'}
	<MachineUnreachable {status} detail="Files open when it is back." />
{:else}
	{#key machine.id}
		<FileBrowser {machine} />
	{/key}
{/if}
