<script lang="ts">
	import PageHeader from '#lib/ui/page-header.svelte';
	import CleanupApprovalCard from './cleanup-approval-card.svelte';
	import type { PageProps } from './$types';

	/**
	 * An AI assistant's clean-up request (SPEC-MCP M54): its approval card while it waits, and
	 * what became of it afterwards.
	 */
	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Approve a clean-up?"
	summary="An AI assistant asks to clean up these items from BMuster's safe list. Nothing is deleted until a person approves it."
	actions={undefined}
/>
{#key data.view.requestId}
	<CleanupApprovalCard view={data.view} now={data.now} />
{/key}
