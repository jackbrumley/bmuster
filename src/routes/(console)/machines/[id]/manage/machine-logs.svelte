<script lang="ts">
	import { onMount } from 'svelte';
	import { IconCopy, IconDownload, IconBug, IconPlayerStop } from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';
	import Checkbox from '#lib/ui/checkbox.svelte';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import LoadingVeil from '#lib/ui/loading-veil.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { agentRecordLine, type AgentLogRecordView } from '#lib/domain/logs/logs.ts';
	import { agentLogPageSchema, verboseReplySchema } from '#lib/schemas/logs/logs.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { copyText } from '#lib/utils/clipboard.ts';
	import {
		LEVEL_OPTIONS,
		SOURCE_OPTIONS,
		SPAN_OPTIONS,
		SHOWN_LIMIT,
		logText,
		logsUrl,
		mergeNewer,
		recordKey,
		remainingLabel,
		type Cursor,
		type Filters,
		type LevelChoice,
		type SourceChoice,
		type SpanChoice
	} from './machine-logs.ts';

	/**
	 * Manage → Logs (SPEC-AGENT-LOGS 4): the machine's stored agent log, newest first, with
	 * filters, a Live toggle that follows new records every five seconds, Copy shown and Download,
	 * and Verbose for 1 hour. Records are plain text in a bounded, scrolling block.
	 */
	let {
		machineId,
		machineName,
		sendsLogs,
		verboseUntilIso
	}: {
		machineId: string;
		machineName: string;
		/** False for an agent from before log shipping (it sent no display report). */
		sendsLogs: boolean;
		verboseUntilIso: string | null;
	} = $props();

	const LIVE_EVERY_MS = 5000;

	let level = $state<LevelChoice | null>('info');
	let source = $state<SourceChoice | null>('all');
	let span = $state<SpanChoice | null>('day');
	let records = $state<AgentLogRecordView[]>([]);
	let older = $state<string | null>(null);
	let newer = $state<string | null>(null);
	let loaded = $state(false);
	let failure = $state<string | undefined>(undefined);
	let live = $state<boolean>(false);
	let now = $state(Date.now());
	// The page's verbose deadline, until this panel changes it.
	let verbose = $derived(verboseUntilIso);

	const filters: Filters = $derived({
		level: level ?? 'info',
		source: source ?? 'all',
		span: span ?? 'day'
	});
	const verboseLeft = $derived(
		verbose !== null && Date.parse(verbose) > now ? remainingLabel(verbose, now) : null
	);

	async function read(cursor: Cursor, chosen: Filters = filters) {
		return apiRequest({
			method: 'GET',
			url: logsUrl(machineId, chosen, cursor, Date.now()),
			body: undefined,
			reply: agentLogPageSchema
		});
	}

	async function reload(chosen: Filters): Promise<void> {
		const result = await read({ kind: 'none' }, chosen);
		loaded = true;
		if (!result.ok) {
			failure = result.message;
			return;
		}
		failure = undefined;
		records = result.data.records;
		older = result.data.older.kind === 'cursor' ? result.data.older.cursor : null;
		newer = result.data.newer;
	}

	async function loadOlder(): Promise<void> {
		if (older === null) return;
		const result = await read({ kind: 'older', cursor: older });
		if (!result.ok) {
			failure = result.message;
			return;
		}
		failure = undefined;
		records = [...records, ...result.data.records].slice(0, SHOWN_LIMIT);
		older = result.data.older.kind === 'cursor' ? result.data.older.cursor : null;
	}

	async function follow(): Promise<void> {
		if (newer === null) return;
		const result = await read({ kind: 'newer', cursor: newer });
		if (!result.ok) {
			failure = result.message;
			return;
		}
		failure = undefined;
		records = mergeNewer(records, result.data.records);
		newer = result.data.newer;
	}

	// Filters changed (and on first show): read again from the newest record.
	$effect(() => {
		void reload(filters);
	});

	onMount(() => {
		const timer = setInterval(() => {
			now = Date.now();
			if (live && document.visibilityState === 'visible') {
				void follow();
			}
		}, LIVE_EVERY_MS);
		return () => {
			clearInterval(timer);
		};
	});

	async function setVerbose(kind: 'hour' | 'stop'): Promise<void> {
		const result = await apiRequest({
			method: 'POST',
			url: `/api/machines/${machineId}/verbose`,
			body: { kind },
			reply: verboseReplySchema
		});
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		verbose = result.data.untilIso;
		now = Date.now();
		const heard = result.data.delivered
			? ''
			: ' The machine is offline; it hears this when it reconnects.';
		showToast(
			kind === 'hour'
				? `${machineName} logs its debug records for the next hour.${heard}`
				: `${machineName} is back to normal logging.${heard}`,
			'success'
		);
	}

	async function copyShown(): Promise<void> {
		const result = await copyText(logText(machineName, records, Date.now()));
		if (result.ok) {
			showToast(`${records.length} records copied.`, 'success');
		} else {
			showToast(`This browser did not allow copying (${result.reason}).`, 'error');
		}
	}

	function download(): void {
		const file = new Blob([logText(machineName, records, Date.now())], {
			type: 'text/plain;charset=utf-8'
		});
		const url = URL.createObjectURL(file);
		const link = document.createElement('a');
		link.href = url;
		link.download = `bmuster-${machineName}-agent-log.txt`;
		link.click();
		URL.revokeObjectURL(url);
	}
</script>

{#snippet verboseAction()}
	{#if verboseLeft === null}
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={() => void setVerbose('hour')}
		>
			<IconBug size={18} /> Verbose for 1 hour
		</Button>
	{:else}
		<span class="verbose">Verbose, {verboseLeft} left</span>
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={() => void setVerbose('stop')}
		>
			<IconPlayerStop size={18} /> Stop
		</Button>
	{/if}
{/snippet}

<LoadingVeil active={!loaded} title="Reading the log" detail={undefined} caption="shown">
	<Panel heading="Logs" actions={verboseAction} tone="normal" padding="normal">
		<div class="filters">
			<ChipGroup label="Level" options={LEVEL_OPTIONS} bind:value={level} />
			<ChipGroup label="Source" options={SOURCE_OPTIONS} bind:value={source} />
			<ChipGroup label="Time" options={SPAN_OPTIONS} bind:value={span} />
		</div>
		<div class="actions">
			<Checkbox label="Live" error={undefined} bind:checked={live} />
			<Button variant="secondary" size="compact" type="button" onclick={() => void copyShown()}>
				<IconCopy size={18} /> Copy shown
			</Button>
			<Button variant="secondary" size="compact" type="button" onclick={download}>
				<IconDownload size={18} /> Download
			</Button>
		</div>
		{#if failure !== undefined}
			<p class="failure" role="alert">
				{failure}{records.length > 0 ? ' The records below are from the last read.' : ''}
			</p>
		{/if}
		{#if loaded && records.length === 0}
			<p class="muted">
				{sendsLogs
					? 'No records match. Try a longer time or a lower level.'
					: 'This agent is too old to send its logs; update it.'}
			</p>
		{:else if records.length > 0}
			<p class="muted">
				{records.length} records, newest first. Terminal output and commands are never sent.
			</p>
			<pre aria-label="Agent log">{#each records as record (recordKey(record))}<span
						class="line {record.level}"
						>{agentRecordLine(record)}
</span>{/each}</pre>
			{#if older !== null}
				<div>
					<Button variant="secondary" size="compact" type="button" onclick={() => void loadOlder()}>
						Show older
					</Button>
				</div>
			{/if}
		{/if}
	</Panel>
</LoadingVeil>

<style>
	.filters,
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.muted,
	.verbose {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.verbose {
		align-self: center;
	}

	.failure {
		color: var(--danger);
		font-size: var(--text-sm);
	}

	pre {
		max-height: 28rem;
		margin: 0;
		overflow: auto;
		padding: var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--surface);
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.line.error {
		color: var(--danger);
	}

	.line.warn {
		color: var(--warning);
	}

	.line.debug,
	.line.trace {
		color: var(--muted);
	}
</style>
