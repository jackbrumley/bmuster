<script lang="ts">
	import PublicPage from '#lib/shell/public-page.svelte';
	import Consent from './consent.svelte';
	import type { PageProps } from './$types';

	/** Connect an AI assistant (SPEC-MCP M7): the consent screen, outside the console frame. */
	let { data, form }: PageProps = $props();

	const outcome = $derived<{ kind: 'none' } | { kind: 'refused'; message: string }>(
		form === null
			? { kind: 'none' }
			: form.kind === 'invalid'
				? { kind: 'refused', message: form.message }
				: {
						kind: 'refused',
						message: `You may not connect ${form.assistantName}. Ask an admin to add you to the group of people who may.`
					}
	);
</script>

<svelte:head>
	<title>Connect an AI assistant · BMuster</title>
</svelte:head>

<PublicPage width="compact">
	<Consent view={data.view} fields={data.fields} userName={data.userName} {outcome} />
</PublicPage>
