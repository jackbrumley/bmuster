<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconAlertTriangle } from '@tabler/icons-svelte-runes';
	import PublicPage from '#lib/shell/public-page.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Sign-in did not work · BMuster</title>
</svelte:head>

<PublicPage width="compact">
	<div class="problem">
		<IconAlertTriangle size={32} />
		<h1>Sign-in did not work</h1>
		<p>{data.message}</p>
		<a href={resolve('/login')}>Back to sign in</a>
	</div>
</PublicPage>

<style>
	.problem {
		display: grid;
		justify-items: center;
		gap: var(--space-3);
		color: var(--warning);
		text-align: center;
	}

	h1 {
		color: var(--text);
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
	}

	p {
		color: var(--text-soft);
	}

	a {
		color: var(--brand);
		font-weight: var(--weight-semibold);
	}
</style>
