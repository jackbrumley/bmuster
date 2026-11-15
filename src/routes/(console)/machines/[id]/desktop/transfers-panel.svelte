<script lang="ts">
	import { IconArrowDown, IconArrowUp, IconArrowsTransferUpDown } from '@tabler/icons-svelte-runes';
	import { sizeText, type TransferRow } from '#lib/domain/session-files/session-files.ts';
	import Button from '#lib/ui/button.svelte';
	import EmptyState from '#lib/ui/empty-state.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import type { SessionFileSender } from './session-file-sender.svelte.ts';

	/**
	 * Every file sent through the screen, newest first (SPEC-SESSION-FILES
	 * 3.3): progress while running, Cancel, then the result. The server keeps
	 * the list for an hour, so it comes back after a reload.
	 */
	let { sender }: { sender: SessionFileSender } = $props();

	const finished = $derived(sender.rows.some((row) => row.state.kind !== 'running'));

	function result(row: TransferRow): string {
		switch (row.state.kind) {
			case 'running':
				return `${sizeText(sender.sentFor(row))} of ${sizeText(row.size)}`;
			case 'done':
				return row.state.savedAs === row.name ? 'Saved' : `Saved as ${row.state.savedAs}`;
			case 'failed':
				return row.state.message;
			case 'cancelled':
				return 'Cancelled';
		}
	}

	$effect(() => {
		// While anything runs, the rows (and the server's byte counts) refresh.
		if (!sender.rows.some((row) => row.state.kind === 'running') && sender.running === 0) {
			return;
		}
		const timer = setInterval(() => void sender.refreshRows(), 1000);
		return () => {
			clearInterval(timer);
		};
	});
</script>

<Panel heading="Transfers" actions={undefined} tone="normal" padding="normal">
	{#if sender.rows.length === 0}
		<EmptyState
			icon={IconArrowsTransferUpDown}
			title="Nothing sent yet"
			detail="Drop files on the screen, or use Upload files, to send them to the machine."
			children={undefined}
		/>
	{:else}
		<ul class="rows" aria-label="Transfers">
			{#each sender.rows as row (row.id)}
				<li class="row" data-state={row.state.kind}>
					<span class="direction" aria-hidden="true">
						{#if row.direction === 'to-machine'}<IconArrowUp size={18} />{:else}<IconArrowDown
								size={18}
							/>{/if}
					</span>
					<span class="name">{row.name}</span>
					<span class="size">{sizeText(row.size)}</span>
					{#if row.state.kind === 'running'}
						<progress
							class="progress"
							max={Math.max(row.size, 1)}
							value={sender.sentFor(row)}
							aria-label="Sending {row.name}"
						></progress>
						<Button
							variant="secondary"
							size="compact"
							type="button"
							onclick={() => {
								sender.cancel(row.id);
							}}>Cancel</Button
						>
					{/if}
					<span class="result" class:failed={row.state.kind === 'failed'}>{result(row)}</span>
				</li>
			{/each}
		</ul>
		{#if finished}
			<div class="actions">
				<Button
					variant="secondary"
					size="compact"
					type="button"
					onclick={() => {
						sender.clearFinished();
					}}>Clear finished</Button
				>
			</div>
		{/if}
	{/if}
</Panel>

<style>
	.rows {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-1) var(--space-2);
		font-size: var(--text-sm);
	}

	.direction {
		display: flex;
		color: var(--muted);
	}

	.name {
		overflow: hidden;
		color: var(--text);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.size {
		color: var(--text-soft);
	}

	.progress {
		grid-column: 2 / 3;
		width: 100%;
		accent-color: var(--brand);
	}

	.result {
		grid-column: 2 / -1;
		color: var(--text-soft);
		overflow-wrap: anywhere;
	}

	.result.failed {
		color: var(--danger);
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		margin-top: var(--space-3);
	}
</style>
