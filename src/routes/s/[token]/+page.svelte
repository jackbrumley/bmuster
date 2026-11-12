<script lang="ts">
	import GuestPage from './guest-page.svelte';
	import type { PageProps } from './$types';

	/** A share link's guest page (SPEC-SHARE-LINKS): one machine, for a while. */
	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>{data.guest.machineName} · BMuster</title>
	<meta name="referrer" content="no-referrer" />
</svelte:head>

<GuestPage token={data.token} guest={data.guest} loadedAtMs={data.nowMs} />
