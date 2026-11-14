<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IconPlayerPlay } from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import SavedCommandForm from '../saved-command-form.svelte';
	import type { PageProps } from './$types';

	/** A saved command's form (SPEC-SAVED-COMMANDS SC2–SC7), admins only; Run when it is on. */
	let { data }: PageProps = $props();
</script>

{#snippet run()}
	<Button
		variant="secondary"
		size="compact"
		type="button"
		onclick={() =>
			void goto(resolve('/(console)/commands/saved/[id=uuid]/run', { id: data.command.id }))}
	>
		<IconPlayerPlay size={18} /> Run
	</Button>
{/snippet}

<PageHeader
	title={data.command.name}
	summary="Version {data.command
		.version}. Every change is in Activity with what it was before, and raises the version."
	actions={data.command.enabled ? run : undefined}
/>

{#key data.command.version}
	<SavedCommandForm
		initial={{ kind: 'edit', command: data.command }}
		groups={data.groups}
		signIn={data.signIn}
	/>
{/key}
