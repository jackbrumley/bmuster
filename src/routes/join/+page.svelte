<script lang="ts">
	import PublicPage from '#lib/shell/public-page.svelte';
	import JoinFlow from './join-flow.svelte';
	import type { PageProps } from './$types';

	/** The public phone support page (SPEC-JOIN): code, who gets access, scam check, command. */
	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Get help · BMuster</title>
</svelte:head>

<PublicPage>
	<JoinFlow organisation={data.organisation} />
</PublicPage>
