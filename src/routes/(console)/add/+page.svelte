<script lang="ts">
	import { dev } from '$app/env';
	import { page } from '$app/state';
	import AddMachine from './add-machine.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<AddMachine
	origin={page.url.origin}
	downloads={data.downloads}
	devServer={dev}
	localTls={data.localTls}
/>
