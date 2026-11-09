<script lang="ts">
	import { onMount } from 'svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import { statsLine, stepLine, type MachineSessionView } from '#lib/domain/logs/checks.ts';
	import { machineSessionsSchema } from '#lib/schemas/logs/checks.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { formatRelative } from '#lib/utils/format.ts';

	/**
	 * Manage → Sessions (SPEC-DIAGNOSTICS 3): the machine's last sessions, newest first, each with
	 * who and when from the server, and the steps and desktop figures the agent shipped.
	 */
	let { machineId }: { machineId: string } = $props();

	let sessions = $state<MachineSessionView[] | undefined>(undefined);
	let failure = $state<string | undefined>(undefined);
	let now = $state(Date.now());

	const empty = $derived(
		failure ??
			(sessions === undefined
				? 'Reading the sessions…'
				: 'No sessions in the last 7 days. Agents before 0.4.3 send no timelines.')
	);

	onMount(() => {
		void (async () => {
			const result = await apiRequest({
				method: 'GET',
				url: `/api/diagnostics/machines/${machineId}/sessions?limit=20`,
				body: undefined,
				reply: machineSessionsSchema
			});
			now = Date.now();
			if (!result.ok) {
				failure = result.message;
				sessions = [];
				return;
			}
			sessions = result.data.sessions;
		})();
	});

	function kindLabel(kind: string): string {
		switch (kind) {
			case 'terminal':
				return 'Terminal';
			case 'exec':
				return 'Command';
			case 'files':
				return 'Files';
			case 'desktop':
				return 'Desktop';
			default:
				return kind;
		}
	}

	function outcome(session: MachineSessionView): { text: string; failed: boolean } {
		if (session.timeline.kind === 'shipped' && session.timeline.outcome === 'failed') {
			return { text: `Failed: ${session.timeline.reason}`, failed: true };
		}
		if (session.server.kind === 'known') {
			return session.server.ended.kind === 'running'
				? { text: 'Running', failed: false }
				: { text: session.server.ended.how, failed: false };
		}
		return session.timeline.kind === 'shipped'
			? { text: `Ended: ${session.timeline.reason}`, failed: false }
			: { text: 'Unknown', failed: false };
	}
</script>

{#snippet row(session: MachineSessionView)}
	{@const ended = outcome(session)}
	<ListRow action={{ kind: 'static' }} align="start" dimmed={false}>
		<div class="body">
			<p class="title">
				{kindLabel(session.kind)}
				<span class="meta">
					{session.server.kind === 'known' ? `${session.server.userName} · ` : ''}{formatRelative(
						session.startedIso,
						now
					)}
				</span>
			</p>
			<p class="outcome" class:failed={ended.failed}>{ended.text}</p>
			{#if session.timeline.kind === 'shipped'}
				<details>
					<summary>Timeline, {session.timeline.steps.length} steps</summary>
					<ol aria-label="Timeline">
						{#each session.timeline.steps as step, index (index)}
							<li>{stepLine(step)}</li>
						{/each}
					</ol>
					{#if session.timeline.omitted > 0}
						<p class="meta">{session.timeline.omitted} steps left out of the middle.</p>
					{/if}
				</details>
			{:else}
				<p class="meta">No timeline from the agent.</p>
			{/if}
			{#each session.stats.slice(0, 1) as stats (stats.atIso)}
				<p class="meta">Last 30 s: {statsLine(stats)}</p>
			{/each}
		</div>
	</ListRow>
{/snippet}

<ListCard
	heading="Sessions"
	actions={undefined}
	label="Sessions on this machine, newest first"
	items={sessions ?? []}
	key={(session: MachineSessionView) => session.sessionId}
	{row}
	{empty}
/>

<style>
	.body {
		display: grid;
		flex: 1;
		gap: var(--space-1);
		min-width: 0;
	}

	.title {
		font-weight: var(--weight-medium);
	}

	.meta {
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: var(--weight-regular);
		overflow-wrap: anywhere;
	}

	.outcome {
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.outcome.failed {
		color: var(--danger);
	}

	summary {
		color: var(--brand);
		cursor: pointer;
		font-size: var(--text-sm);
	}

	ol {
		display: grid;
		gap: var(--space-1);
		margin: var(--space-2) 0 0;
		padding-left: var(--space-5);
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}
</style>
