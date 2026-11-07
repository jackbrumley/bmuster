<script lang="ts">
	import { page } from '$app/state';
	import { errorPlace } from '#lib/domain/errors/error-copy.ts';
	import ConsoleError from './console-error.svelte';

	/**
	 * Errors on console pages, inside the console frame (SPEC-ERROR-PAGES E2).
	 * A machine that doesn't exist, or that the person may not see, lands here
	 * from the machine layout: 404 either way (SPEC-ACCESS A6).
	 */
</script>

<ConsoleError
	status={page.status}
	message={page.error?.message ?? ''}
	reference={page.error?.reference}
	place={errorPlace(page.route.id)}
	header="page"
/>
