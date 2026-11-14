<script lang="ts">
	import { resolve } from '$app/paths';
	import { inUseText, type SessionInUse } from '#lib/domain/sessions/session.ts';

	/**
	 * Who is using a machine now, the entries of "In use: …" (SPEC-SESSIONS T8). A command links
	 * to its run's results with this machine's output open, following it live (SPEC-COMMANDS C24).
	 */
	let { machineId, sessions }: { machineId: string; sessions: readonly SessionInUse[] } = $props();

	const query = $derived(new URLSearchParams({ machine: machineId }).toString());
</script>

{#each sessions as session, index (index)}
	{index > 0 ? ', ' : ''}
	{#if session.kind === 'command'}
		<a class="run" href="{resolve('/(console)/commands/[id=uuid]', { id: session.runId })}?{query}"
			>{inUseText(session)}</a
		>
	{:else}
		{inUseText(session)}
	{/if}
{/each}

<style>
	.run {
		color: var(--brand);
		text-decoration: underline;
	}
</style>
