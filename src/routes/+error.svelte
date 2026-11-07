<script lang="ts">
	import { page } from '$app/state';
	import PublicError from './public-error.svelte';

	/**
	 * Errors outside the console's own pages (SPEC-ERROR-PAGES E1). Signing in
	 * comes back here, unless there is nothing here to come back to.
	 */
	const returnTo = $derived(page.status === 404 ? '/' : `${page.url.pathname}${page.url.search}`);
</script>

<PublicError
	status={page.status}
	message={page.error?.message ?? ''}
	reference={page.error?.reference}
	signedIn={page.data.signedIn}
	{returnTo}
/>
