<script lang="ts">
	import PageHeader from '#lib/ui/page-header.svelte';
	import SavedCommandForm from '../saved-command-form.svelte';
	import type { PageProps } from './$types';

	/** New saved command (SPEC-SAVED-COMMANDS SC2–SC6), admins only. */
	let { data }: PageProps = $props();
</script>

<PageHeader
	title="New saved command"
	summary="A script written once, run on many machines in two clicks. It runs as Administrator (root or SYSTEM)."
	actions={undefined}
/>

<SavedCommandForm initial={{ kind: 'new' }} groups={data.groups} signIn={data.signIn} />
