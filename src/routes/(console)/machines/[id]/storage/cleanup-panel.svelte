<script lang="ts">
	import { onMount } from 'svelte';
	import { IconAlertTriangle, IconCheck, IconTrash, IconSearch } from '@tabler/icons-svelte-runes';
	import {
		CLEANUP_CATALOGUE,
		cleanupLabel,
		confirmText,
		resultText,
		runTotals,
		selectionText,
		sizeText,
		type CleanupItemId,
		type CleanupItemProgress,
		type CleanupItemSize,
		type CleanupRun
	} from '#lib/domain/storage/cleanup.ts';
	import Button from '#lib/ui/button.svelte';
	import Checkbox from '#lib/ui/checkbox.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import LoadingVeil from '#lib/ui/loading-veil.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import RadarSpinner from '#lib/ui/radar-spinner.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { formatBytes } from '#lib/utils/format.ts';
	import type { storageApi } from './storage-api.ts';

	/**
	 * Clean up (SPEC-STORAGE 11.6): the machine's fixed list of known-safe items, sized first,
	 * ticked, confirmed, then run on the machine with progress and results. Only item ids are sent.
	 * The clean-up runs on the machine, so a person can leave and come back to it.
	 */
	let { api }: { api: ReturnType<typeof storageApi> } = $props();

	type View =
		| { kind: 'loading' }
		| { kind: 'idle' }
		| { kind: 'measuring' }
		| { kind: 'measured'; sizes: CleanupItemSize[] }
		| { kind: 'starting'; sizes: CleanupItemSize[] }
		| { kind: 'run'; run: Exclude<CleanupRun, { kind: 'none' }> }
		| { kind: 'failed'; message: string };

	/** How often a running clean-up is asked about. */
	const POLL_MS = 3000;

	let view = $state<View>({ kind: 'loading' });
	let ticked = $state<CleanupItemId[]>([]);

	const tickedSet = $derived<ReadonlySet<CleanupItemId>>(new Set(ticked));

	function tick(id: CleanupItemId, on: boolean): void {
		ticked = on
			? [...ticked.filter((other) => other !== id), id]
			: ticked.filter((other) => other !== id);
	}

	onMount(() => {
		void loadStatus(true);
		const timer = setInterval(() => {
			if (view.kind === 'run' && view.run.kind === 'running') {
				void loadStatus(false);
			}
		}, POLL_MS);
		return () => {
			clearInterval(timer);
		};
	});

	/** On opening, a clean-up still running is shown; otherwise the panel waits to measure. */
	async function loadStatus(opening: boolean): Promise<void> {
		const result = await api.cleanupStatus();
		if (!result.ok) {
			if (opening) {
				view = { kind: 'failed', message: result.message };
			}
			return;
		}
		const run = result.data.run;
		if (run.kind === 'running' || !opening) {
			if (run.kind !== 'none') {
				view = { kind: 'run', run };
			}
		} else {
			view = { kind: 'idle' };
		}
	}

	async function measure(): Promise<void> {
		view = { kind: 'measuring' };
		ticked = [];
		const result = await api.cleanupItems();
		view = result.ok
			? { kind: 'measured', sizes: result.data.items }
			: { kind: 'failed', message: result.message };
	}

	async function cleanUp(sizes: CleanupItemSize[]): Promise<void> {
		const items = sizes.filter((item) => tickedSet.has(item.id)).map((item) => item.id);
		if (items.length === 0) {
			showToast('Tick at least one item to clean up.', 'error');
			return;
		}
		const yes = await confirmAction({
			title: `Clean up ${items.length} ${items.length === 1 ? 'item' : 'items'}?`,
			message: confirmText(sizes, tickedSet),
			confirmLabel: 'Clean up'
		});
		if (!yes) {
			return;
		}
		view = { kind: 'starting', sizes };
		const started = await api.startCleanup(items);
		if (!started.ok) {
			showToast(started.message, 'error');
			view = { kind: 'measured', sizes };
			return;
		}
		view = {
			kind: 'run',
			run: {
				kind: 'running',
				runId: started.data.runId,
				startedAtMs: Date.now(),
				items: items.map((id) => ({ id, state: { kind: 'waiting' } }))
			}
		};
	}

	function stateText(item: CleanupItemProgress): string {
		switch (item.state.kind) {
			case 'waiting':
				return 'Waiting';
			case 'running':
				return `Cleaning… ${formatBytes(item.state.freedBytes)} freed so far`;
			case 'done':
				return resultText(item.state.result);
		}
	}
</script>

{#snippet sizeRow(item: CleanupItemSize)}
	<ListRow action={{ kind: 'static' }} align="start" dimmed={false}>
		<div class="item">
			<Checkbox
				label={cleanupLabel(item.id)}
				error={undefined}
				bind:checked={
					() => tickedSet.has(item.id),
					(on: boolean) => {
						tick(item.id, on);
					}
				}
			/>
			<p class="size">{sizeText(item.size)}</p>
			<p class="explanation">{CLEANUP_CATALOGUE[item.id].explanation}</p>
		</div>
	</ListRow>
{/snippet}

{#snippet progressRow(item: CleanupItemProgress)}
	<ListRow action={{ kind: 'static' }} align="start" dimmed={false}>
		<span class="state-icon">
			{#if item.state.kind === 'running'}
				<RadarSpinner size="small" />
			{:else if item.state.kind === 'done' && item.state.result.errors > 0}
				<IconAlertTriangle size={20} />
			{:else if item.state.kind === 'done'}
				<IconCheck size={20} />
			{/if}
		</span>
		<div class="item">
			<p class="label">{cleanupLabel(item.id)}</p>
			<p class="size">{stateText(item)}</p>
			{#if item.state.kind === 'done' && item.state.result.messages.length > 0}
				<ul class="errors">
					{#each item.state.result.messages as message, index (index)}
						<li>{message}</li>
					{/each}
				</ul>
			{/if}
		</div>
	</ListRow>
{/snippet}

<Panel heading="Clean up" actions={undefined} tone="normal" padding="normal">
	{#if view.kind === 'loading'}
		<LoadingVeil
			active={true}
			title="Checking for a clean-up"
			detail={undefined}
			children={undefined}
		/>
	{:else if view.kind === 'idle'}
		<p class="hint">
			Free space from a fixed list of things that are safe to delete: temporary files, caches, crash
			dumps and old downloads. Each item is measured first; nothing is deleted until you tick it and
			confirm.
		</p>
		<div class="actions">
			<Button variant="secondary" size="compact" type="button" onclick={() => void measure()}>
				<IconSearch size={18} /> Find what can be cleaned up
			</Button>
		</div>
	{:else if view.kind === 'measuring'}
		<LoadingVeil
			active={true}
			title="Measuring what can be cleaned up"
			detail="This can take a minute on a machine with many files."
			children={undefined}
		/>
	{:else if view.kind === 'measured' || view.kind === 'starting'}
		{@const sizes = view.sizes}
		<ListCard
			heading={undefined}
			actions={undefined}
			label="Items to clean up"
			items={sizes}
			key={(item: CleanupItemSize) => item.id}
			row={sizeRow}
			empty="Nothing on this machine can be cleaned up this way."
		/>
		<div class="actions">
			<p class="total">{selectionText(sizes, tickedSet)}</p>
			<Button variant="danger" size="compact" type="button" onclick={() => void cleanUp(sizes)}>
				{#if view.kind === 'starting'}
					<RadarSpinner size="small" />
				{:else}
					<IconTrash size={18} />
				{/if}
				Clean up
			</Button>
		</div>
	{:else if view.kind === 'run'}
		{@const run = view.run}
		{@const totals = runTotals(run.items)}
		{#if run.kind === 'interrupted'}
			<Notice tone="warning" title="The clean-up stopped before the end.">
				<p>The agent stopped, or the machine restarted. What finished is shown below.</p>
			</Notice>
		{/if}
		<ListCard
			heading={undefined}
			actions={undefined}
			label="Clean-up progress"
			items={run.items}
			key={(item: CleanupItemProgress) => item.id}
			row={progressRow}
			empty="No items."
		/>
		{#if run.kind === 'running'}
			<p class="total">Cleaning up on the machine. You can leave this page; it carries on.</p>
		{:else}
			<div class="actions">
				<p class="total">
					Freed {formatBytes(totals.freedBytes)} in all{totals.filesSkipped > 0
						? `, ${totals.filesSkipped} files skipped`
						: ''}
				</p>
				<Button variant="secondary" size="compact" type="button" onclick={() => void measure()}>
					<IconSearch size={18} /> Measure again
				</Button>
			</div>
		{/if}
	{:else}
		<Notice tone="danger" title="Could not reach the clean-up.">
			<p>{view.message}</p>
		</Notice>
		<div class="actions">
			<Button variant="secondary" size="compact" type="button" onclick={() => void measure()}>
				Try again
			</Button>
		</div>
	{/if}
</Panel>

<style>
	.hint,
	.total {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.item {
		display: grid;
		flex: 1;
		min-width: 0;
		gap: var(--space-1);
	}

	.label {
		margin: 0;
		font-weight: var(--weight-medium);
	}

	.size {
		margin: 0;
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	.explanation {
		margin: 0;
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.state-icon {
		display: inline-flex;
		width: 20px;
		color: var(--text-soft);
	}

	.errors {
		margin: 0;
		padding-left: var(--space-4);
		color: var(--danger);
		font-size: var(--text-xs);
	}
</style>
