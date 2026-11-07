<script lang="ts">
	import { page } from '$app/state';
	import ConsoleError from '../../console-error.svelte';

	/**
	 * Errors on one of a machine's tabs (SPEC-ERROR-PAGES E3), such as a
	 * member opening Manage: the machine's header and tabs stay above it.
	 */
</script>

<ConsoleError
	status={page.status}
	message={page.error?.message ?? ''}
	reference={page.error?.reference}
	place="machine"
	header="machine"
/>
