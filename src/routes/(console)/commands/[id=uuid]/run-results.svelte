<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		commandOsLabel,
		commandShellLabel,
		countsLine,
		needsRunAgain,
		runMachineStatusLabel,
		type CommandDraft,
		type RunMachineOutput,
		type RunMachineStatus,
		type RunMachineView,
		type RunView
	} from '#lib/domain/commands/commands.ts';
	import {
		cancelRunReplySchema,
		COMMAND_RUN_EVENT,
		runOutputReplySchema,
		runViewSchema
	} from '#lib/schemas/commands/commands.ts';
	import Button from '#lib/ui/button.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import LoadingVeil from '#lib/ui/loading-veil.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiEvents, apiRequest } from '#lib/utils/api-client.ts';
	import { formatBytes } from '#lib/utils/format.ts';

	/**
	 * A run's results (SPEC-COMMANDS C16–C18): one row per machine, updating live, the top line
	 * counting them. Tapping a row shows that machine's output. Cancel run stops machines not
	 * started yet; Run again on failed and offline goes back through Run command and Review.
	 */
	let { initial, now }: { initial: RunView; now: number } = $props();

	let pushed = $state<RunView | undefined>(undefined);
	const run = $derived(pushed ?? initial);

	/** Without the live feed (a refused stream), the page asks every few seconds while it runs. */
	const POLL_MS = 5_000;

	async function reload(): Promise<void> {
		const result = await apiRequest({
			method: 'GET',
			url: resolve('/api/commands/runs/[id=uuid]', { id: initial.id }),
			body: undefined,
			reply: runViewSchema
		});
		if (result.ok) {
			pushed = result.data;
		}
	}

	onMount(() => {
		let poll: ReturnType<typeof setInterval> | undefined;
		const stop = apiEvents({
			url: resolve('/api/commands/runs/[id=uuid]/events', { id: initial.id }),
			event: COMMAND_RUN_EVENT,
			reply: runViewSchema,
			onEvent: (next) => {
				pushed = next;
			},
			onReconnect: () => {
				void reload();
			},
			onFailure: () => {
				poll ??= setInterval(() => {
					if (run.status === 'running') {
						void reload();
					}
				}, POLL_MS);
			}
		});
		return () => {
			stop();
			clearInterval(poll);
		};
	});

	const again = $derived(run.machines.filter((machine) => needsRunAgain(machine.status)));

	function runAgain(): void {
		const commandDraft: CommandDraft = {
			machineIds: again.map((machine) => machine.machineId),
			scripts: run.scripts,
			timeoutMs: run.timeoutMs,
			rerunOf: run.id
		};
		void goto(resolve('/(console)/commands/new'), { state: { commandDraft } });
	}

	let cancelling = $state(false);

	async function cancel(): Promise<void> {
		const yes = await confirmAction({
			title: 'Cancel this run?',
			message:
				'Machines that have not started will not run it. Machines already running finish or reach their time limit.',
			confirmLabel: 'Cancel run'
		});
		if (!yes) {
			return;
		}
		cancelling = true;
		const result = await apiRequest({
			method: 'POST',
			url: resolve('/api/commands/runs/[id=uuid]/cancel', { id: run.id }),
			body: {},
			reply: cancelRunReplySchema
		});
		cancelling = false;
		if (result.ok) {
			showToast(
				`Cancelled: ${result.data.cancelled} ${result.data.cancelled === 1 ? 'machine' : 'machines'} will not run it.`,
				'success'
			);
			void reload();
		} else {
			showToast(result.message, 'error');
		}
	}

	type Shown =
		| { kind: 'none' }
		| { kind: 'loading'; machine: RunMachineView }
		| { kind: 'shown'; machine: RunMachineView; output: RunMachineOutput };

	let shown = $state<Shown>({ kind: 'none' });

	async function showOutput(machine: RunMachineView): Promise<void> {
		shown = { kind: 'loading', machine };
		const result = await apiRequest({
			method: 'GET',
			url: resolve('/api/commands/runs/[id=uuid]/machines/[machineId=uuid]', {
				id: run.id,
				machineId: machine.machineId
			}),
			body: undefined,
			reply: runOutputReplySchema
		});
		if (result.ok) {
			shown = { kind: 'shown', machine, output: result.data };
		} else {
			shown = { kind: 'none' };
			showToast(result.message, 'error');
		}
	}

	function tone(status: RunMachineStatus): 'good' | 'bad' | 'quiet' | 'busy' {
		switch (status) {
			case 'succeeded':
				return 'good';
			case 'failed':
			case 'timed-out':
			case 'lost':
				return 'bad';
			case 'offline':
			case 'skipped':
			case 'cancelled':
				return 'quiet';
			case 'waiting':
			case 'running':
				return 'busy';
		}
	}

	function resultText(machine: RunMachineView): string {
		const parts = [
			...(machine.exitCode === null ? [] : [`exit ${machine.exitCode}`]),
			...(machine.durationMs === null ? [] : [`${Math.round(machine.durationMs / 100) / 10} s`]),
			...(machine.reason === '' ? [] : [machine.reason])
		];
		return parts.join(' · ');
	}

	/** For an AI assistant's run (SPEC-MCP M28): what was decided, by whom, and the reason. */
	const decisionText = $derived.by((): string => {
		if (run.origin.kind === 'person') {
			return '';
		}
		const decision = run.origin.decision;
		switch (decision.kind) {
			case 'pending':
				return 'Waiting for approval';
			case 'approved':
				return `Approved by ${decision.by}${decision.edit.kind === 'edited' ? ', edited' : ''}`;
			case 'denied':
				return decision.note === ''
					? `Denied by ${decision.by}`
					: `Denied by ${decision.by}: ${decision.note}`;
			case 'expired':
				return 'Expired: nobody decided within 10 minutes';
			case 'cancelled':
				return 'Withdrawn before anyone decided';
		}
	});

	const startedText = $derived(
		`Started by ${run.startedBy} ${new Date(run.startedIso).toLocaleString('en-AU')}`
	);
	const ago = $derived(Math.max(0, Math.round((now - Date.parse(run.startedIso)) / 60_000)));
</script>

<div class="results">
	<Panel heading={undefined} actions={undefined} tone="normal" padding="normal">
		<div class="summary">
			<p class="counts">{countsLine(run.counts)}</p>
			<p class="meta">
				{startedText}{ago > 0 ? ` (${ago} min ago)` : ''} · time limit {run.timeoutMs / 1000} s
			</p>
			{#if run.origin.kind === 'assistant'}
				<p class="decision">{decisionText}</p>
				<p class="meta">{run.origin.assistant} said: {run.origin.reason}</p>
				{#if run.origin.decision.kind === 'approved' && run.origin.decision.edit.kind === 'edited'}
					<p class="shell">Asked for (before the edit)</p>
					<pre class="command">{run.origin.decision.edit.requestedCommand}</pre>
				{/if}
			{/if}
			{#each run.scripts as script (script.osFamily)}
				<p class="shell">{commandOsLabel(script.osFamily)} · {commandShellLabel(script.shell)}</p>
				<pre class="command">{script.command}</pre>
			{/each}
			{#if run.canCancel || again.length > 0}
				<div class="actions">
					{#if run.canCancel}
						<LoadingVeil active={cancelling} title="Cancelling" detail={undefined}>
							<Button
								variant="danger"
								size="compact"
								type="button"
								onclick={() => {
									void cancel();
								}}>Cancel run</Button
							>
						</LoadingVeil>
					{/if}
					{#if again.length > 0 && run.status !== 'running'}
						<Button variant="primary" size="compact" type="button" onclick={runAgain}
							>Run again on failed and offline</Button
						>
					{/if}
				</div>
			{/if}
		</div>
	</Panel>

	<ListCard
		heading="Machines"
		actions={undefined}
		label="Machines in this run"
		items={run.machines}
		key={(machine: RunMachineView) => machine.machineId}
		empty="No machines you can see."
	>
		{#snippet row(machine: RunMachineView)}
			<ListRow
				action={{
					kind: 'button',
					onclick: () => {
						void showOutput(machine);
					}
				}}
				align="start"
				dimmed={false}
			>
				<span class="machine">
					<span class="name">{machine.machineName}</span>
					<span class="detail">{resultText(machine)}</span>
				</span>
				<span class="status {tone(machine.status)}">{runMachineStatusLabel(machine.status)}</span>
			</ListRow>
		{/snippet}
	</ListCard>

	{#if shown.kind !== 'none'}
		<Panel
			heading="Output: {shown.machine.machineName}"
			actions={undefined}
			tone="normal"
			padding="normal"
		>
			<LoadingVeil active={shown.kind === 'loading'} title="Loading the output" detail={undefined}>
				{#if shown.kind === 'shown'}
					{#if shown.output.kind === 'none'}
						<p class="meta">No output yet: the machine has not finished.</p>
					{:else if shown.output.kind === 'deleted'}
						<p class="meta">Output is kept for 30 days; this run's has been deleted.</p>
					{:else}
						<div class="output">
							<p class="shell">
								Output{shown.output.stdoutTruncated ? ' (cut off at 1 MB)' : ''}
							</p>
							<pre class="command">{shown.output.stdout === ''
									? '(none)'
									: shown.output.stdout}</pre>
							<p class="shell">
								Errors{shown.output.stderrTruncated ? ' (cut off at 1 MB)' : ''}
							</p>
							<pre class="command">{shown.output.stderr === ''
									? '(none)'
									: shown.output.stderr}</pre>
							{#if shown.machine.output.kind === 'kept'}
								<p class="meta">{formatBytes(shown.machine.output.bytes)} in all</p>
							{/if}
						</div>
					{/if}
				{/if}
			</LoadingVeil>
		</Panel>
	{/if}
</div>

<style>
	.results,
	.summary,
	.output {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
	}

	.results {
		gap: var(--gap-section);
	}

	.counts {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.meta,
	.detail {
		color: var(--muted);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}

	.decision {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.shell {
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.command {
		max-height: 400px;
		margin: 0;
		padding: var(--space-3);
		overflow: auto;
		border-radius: var(--radius-inner);
		background: var(--surface-muted);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		white-space: pre;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.machine {
		display: grid;
		flex: 1;
		gap: var(--space-0-5);
		min-width: 0;
	}

	.name {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.status {
		flex-shrink: 0;
		padding: var(--space-0-5) var(--space-2);
		border-radius: var(--radius-pill);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
	}

	.good {
		background: var(--success-bg);
		color: var(--success);
	}

	.bad {
		background: var(--danger-bg);
		color: var(--danger);
	}

	.quiet {
		background: var(--surface-muted);
		color: var(--muted);
	}

	.busy {
		background: var(--brand-tint);
		color: var(--brand);
	}
</style>
