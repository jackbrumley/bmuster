<script lang="ts">
	import MachineLayout from '../+layout.svelte';
	import FilesTab from './+page.svelte';
	import type { PageProps } from './$types';

	/**
	 * The Files tab under the machine's own layout (header, tabs and the one
	 * live status): what the presence tests drive (SPEC-PRESENCE P10).
	 */
	let { pageProps }: { pageProps: PageProps } = $props();
</script>

<MachineLayout data={pageProps.data} params={pageProps.params}>
	<FilesTab {...pageProps} />
</MachineLayout>
