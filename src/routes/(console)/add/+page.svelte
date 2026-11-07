<script lang="ts">
	import { dev } from '$app/env';
	import { page } from '$app/state';
	import PageHeader from '#lib/ui/page-header.svelte';
	import AddMachine from './add-machine.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Add a machine"
	summary="Run one command on the machine. It joins this server and shows up under Machines."
	actions={undefined}
/>

<AddMachine
	origin={page.url.origin}
	downloads={data.downloads}
	devServer={dev}
	localTls={data.localTls}
	machineGroups={data.machineGroups}
/>
