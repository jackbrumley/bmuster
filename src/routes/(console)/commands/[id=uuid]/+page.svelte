<script lang="ts">
	import PageHeader from '#lib/ui/page-header.svelte';
	import RunResults from './run-results.svelte';
	import type { PageProps } from './$types';

	/** A run's results page (SPEC-COMMANDS C16–C18); it survives a reload: runs live on the server. */
	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Command run"
	summary="One row per machine, updating as each finishes. Tap a machine to see its output."
	actions={undefined}
/>

<RunResults initial={data.run} now={data.now} />
