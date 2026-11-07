<script lang="ts">
	import type { Snippet } from 'svelte';
	import PublicPage from '#lib/shell/public-page.svelte';
	import JoinFlow from './join-flow.svelte';
	import type { PageProps } from './$types';

	/** The public phone support page (SPEC-JOIN): code, who gets access, scam check, command. */
	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Get help · BMuster</title>
</svelte:head>

<JoinFlow organisation={data.organisation}>
	{#snippet frame(width: 'compact' | 'wide', children: Snippet)}
		<PublicPage {width}>
			{@render children()}
		</PublicPage>
	{/snippet}
</JoinFlow>
