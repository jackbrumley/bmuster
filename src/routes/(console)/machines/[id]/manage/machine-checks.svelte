<script lang="ts">
	import { onMount } from 'svelte';
	import {
		IconCircleCheck,
		IconCircleMinus,
		IconCircleX,
		IconPlayerPlay
	} from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import LoadingVeil from '#lib/ui/loading-veil.svelte';
	import RadarSpinner from '#lib/ui/radar-spinner.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import type { CheckResultView, MachineChecks } from '#lib/domain/logs/checks.ts';
	import { machineChecksSchema, runChecksReplySchema } from '#lib/schemas/logs/checks.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { formatRelative } from '#lib/utils/format.ts';

	/**
	 * Manage → Checks (SPEC-DIAGNOSTICS 1): the agent's latest self-checks, each pass, fail with
	 * its reason, or not applicable. Run checks asks the agent to run them now (once a minute) and
	 * follows until the new results arrive.
	 */
	let { machineId, machineName }: { machineId: string; machineName: string } = $props();

	/** After Run checks, read again this often, this many times (the whole run takes under a minute). */
	const FOLLOW_EVERY_MS = 5000;
	const FOLLOW_TIMES = 18;

	let checks = $state<MachineChecks | undefined>(undefined);
	let failure = $state<string | undefined>(undefined);
	let following = $state(0);
	let now = $state(Date.now());

	const results: CheckResultView[] = $derived(checks?.kind === 'results' ? checks.results : []);
	const failed = $derived(results.filter((result) => result.status === 'fail').length);
	const summary = $derived.by(() => {
		if (checks?.kind !== 'results' || results.length === 0) return undefined;
		const passed = results.filter((result) => result.status === 'pass').length;
		return `${passed} passed, ${failed} failed · ${formatRelative(checks.receivedIso, now)}`;
	});
	/** The first read, or a run whose results have not arrived yet: the card waits under the veil. */
	const waiting = $derived.by(() => {
		if (following > 0) return 'Running the checks';
		if (checks === undefined && failure === undefined) return 'Reading the checks';
		return undefined;
	});
	const empty = $derived.by(() => {
		if (failure !== undefined) return failure;
		switch (checks?.kind) {
			case undefined:
				// The first read: the veil says so.
				return '';
			case 'unreported':
				return 'This agent is too old to run checks; update it.';
			case 'pending':
				return 'The agent runs its checks a minute after it starts; they will show here.';
			case 'results':
				return 'The agent sent no checks.';
		}
	});

	async function read(): Promise<void> {
		const result = await apiRequest({
			method: 'GET',
			url: `/api/diagnostics/machines/${machineId}/checks`,
			body: undefined,
			reply: machineChecksSchema
		});
		now = Date.now();
		if (!result.ok) {
			failure = result.message;
			return;
		}
		failure = undefined;
		checks = result.data;
	}

	onMount(() => {
		void read();
		const timer = setInterval(() => {
			now = Date.now();
			if (following > 0) {
				following -= 1;
				const before = checks?.kind === 'results' ? checks.receivedIso : '';
				void read().then(() => {
					if (checks?.kind === 'results' && checks.receivedIso !== before) following = 0;
				});
			}
		}, FOLLOW_EVERY_MS);
		return () => {
			clearInterval(timer);
		};
	});

	async function runChecks(): Promise<void> {
		const result = await apiRequest({
			method: 'POST',
			url: `/api/machines/${machineId}/checks`,
			body: undefined,
			reply: runChecksReplySchema
		});
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		following = FOLLOW_TIMES;
		showToast(
			`${machineName} is running its checks; the results show here in a minute.`,
			'success'
		);
	}
</script>

{#snippet actions()}
	<Button variant="secondary" size="compact" type="button" onclick={() => void runChecks()}>
		{#if following > 0}
			<RadarSpinner size="small" /> Running checks
		{:else}
			<IconPlayerPlay size={18} /> Run checks
		{/if}
	</Button>
{/snippet}

{#snippet row(result: CheckResultView)}
	<ListRow action={{ kind: 'static' }} align="start" dimmed={result.status === 'not-applicable'}>
		<span class="icon {result.status}" aria-hidden="true">
			{#if result.status === 'pass'}
				<IconCircleCheck size={20} />
			{:else if result.status === 'fail'}
				<IconCircleX size={20} />
			{:else}
				<IconCircleMinus size={20} />
			{/if}
		</span>
		<div class="body">
			<p class="title">
				<span>{result.title}</span>
				<span class="status">
					{result.status === 'pass' ? 'Pass' : result.status === 'fail' ? 'Fail' : 'Not applicable'}
				</span>
			</p>
			<p class="meta">{result.id} · {result.durationMs} ms</p>
			{#if result.detail !== ''}
				<p class="detail">{result.detail}</p>
			{/if}
		</div>
	</ListRow>
{/snippet}

<LoadingVeil
	active={waiting !== undefined}
	title={waiting ?? ''}
	detail={following > 0 ? `${machineName} sends the results within a minute.` : undefined}
>
	<ListCard
		heading={summary === undefined ? 'Checks' : `Checks · ${summary}`}
		{actions}
		label="Self-checks, in the order the agent runs them"
		items={results}
		key={(result: CheckResultView) => result.id}
		{row}
		{empty}
	/>
</LoadingVeil>

<style>
	.icon {
		display: inline-flex;
		flex: none;
		color: var(--muted);
	}

	.icon.pass {
		color: var(--success);
	}

	.icon.fail {
		color: var(--danger);
	}

	.body {
		display: grid;
		flex: 1;
		gap: var(--space-1);
		min-width: 0;
	}

	.title {
		font-weight: var(--weight-medium);
	}

	.status,
	.meta {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.detail {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
