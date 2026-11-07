<script lang="ts">
	import { IconPlugConnected } from '@tabler/icons-svelte-runes';
	import { hasPermission } from '#lib/domain/access/access.ts';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import NoPermission from '../no-permission.svelte';
	import FileBrowser from './file-browser.svelte';
	import type { PageProps } from './$types';

	/** The machine's Files tab (SPEC-FILES), for people with the `files` permission (F1, F11). */
	let { data }: PageProps = $props();

	const machine = $derived(data.machine);
</script>

{#if !hasPermission(data.grants, 'files')}
	<NoPermission />
{:else if machine.status.kind === 'offline'}
	<EmptyState
		icon={IconPlugConnected}
		title="This machine is offline."
		detail="Files open when it checks in again."
		children={undefined}
	/>
{:else}
	{#key machine.id}
		<FileBrowser {machine} />
	{/key}
{/if}
