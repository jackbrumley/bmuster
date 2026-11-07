<script lang="ts">
	import { IconRefresh, IconX } from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import { formatBytes, percentOf } from '#lib/utils/format.ts';
	import type { Upload, UploadQueue } from './upload-queue.svelte.ts';

	/** Uploads in progress (SPEC-FILES F10): progress, cancel and try again per file. */
	let { queue }: { queue: UploadQueue } = $props();

	function status(upload: Upload): string {
		switch (upload.state.kind) {
			case 'waiting':
				return 'Waiting';
			case 'sending':
				return `${formatBytes(upload.sent)} of ${formatBytes(upload.size)}`;
			case 'retrying':
				return upload.state.message;
			case 'checking':
				return 'Checking on the machine…';
			case 'done':
				return 'Done';
			case 'failed':
				return upload.state.message;
			case 'cancelled':
				return 'Cancelled';
		}
	}

	const finished = $derived(queue.items.length - queue.active);
</script>

{#snippet clear()}
	{#if finished > 0}
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={() => {
				queue.clearFinished();
			}}>Clear finished</Button
		>
	{/if}
{/snippet}

<Panel
	heading={queue.active > 0 ? `Uploading ${queue.active}` : 'Uploads'}
	actions={clear}
	tone="normal"
	padding="normal"
>
	<ul class="uploads" aria-label="Uploads">
		{#each queue.items as upload (upload.id)}
			<li class="upload">
				<div class="line">
					<span class="name">{upload.name}</span>
					{#if upload.state.kind === 'failed'}
						<button
							data-raw-button="icon"
							type="button"
							class="icon-button"
							aria-label="Try {upload.name} again"
							onclick={() => {
								queue.retry(upload);
							}}><IconRefresh size={18} /></button
						>
					{/if}
					{#if ['waiting', 'sending', 'retrying', 'checking'].includes(upload.state.kind)}
						<button
							data-raw-button="icon"
							type="button"
							class="icon-button"
							aria-label="Cancel {upload.name}"
							onclick={() => {
								queue.cancel(upload);
							}}><IconX size={18} /></button
						>
					{/if}
				</div>
				<div
					class="track"
					role="progressbar"
					aria-label="{upload.name} sent"
					aria-valuenow={percentOf(upload.sent, upload.size)}
					aria-valuemin={0}
					aria-valuemax={100}
				>
					<div
						class="fill {upload.state.kind}"
						style:width="{upload.size === 0 ? 100 : percentOf(upload.sent, upload.size)}%"
					></div>
				</div>
				<span class="status" class:problem={upload.state.kind === 'failed'}>{status(upload)}</span>
			</li>
		{/each}
	</ul>
</Panel>

<style>
	.uploads {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.upload {
		display: grid;
		gap: var(--space-1);
	}

	.line {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}

	.icon-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: none;
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--text-soft);
		cursor: pointer;
	}

	.icon-button:hover {
		background: var(--surface-muted);
	}

	.track {
		height: 6px;
		overflow: hidden;
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
	}

	.fill {
		height: 100%;
		border-radius: var(--radius-pill);
		background: var(--brand);
		transition: width 150ms linear;
	}

	.fill.done {
		background: var(--success);
	}

	.fill.failed,
	.fill.cancelled {
		background: var(--border-strong);
	}

	.fill.retrying {
		background: var(--warning);
	}

	.status {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.status.problem {
		color: var(--danger);
	}
</style>
