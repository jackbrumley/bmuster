<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { IconBell, IconX } from '@tabler/icons-svelte-runes';
	import {
		approvalId,
		approvalText,
		type ApprovalSummary
	} from '#lib/domain/commands/assistant-runs.ts';
	import { onLiveEvent } from '#lib/runes/live-events.svelte.ts';

	/**
	 * The live notice of an AI assistant's request (SPEC-MCP M26), a command or a clean-up (M54):
	 * every open console tab of a person who may decide it shows the request with **Review**, which
	 * opens its approval card.
	 * It stays until it is reviewed, dismissed or decided elsewhere; the newest request shows.
	 */

	let shown = $state<ApprovalSummary | null>(null);

	onMount(() =>
		onLiveEvent((event) => {
			switch (event.kind) {
				case 'approval-requested':
					shown = event.approval;
					return;
				case 'approval-decided':
					if (shown !== null && approvalId(shown) === event.id) {
						shown = null;
					}
					return;
			}
		})
	);
</script>

{#if shown !== null}
	<div class="notice" role="status">
		<IconBell size={18} stroke={1.75} />
		<span class="message">{approvalText(shown)}</span>
		{#if shown.kind === 'command'}
			<a
				class="review"
				href={resolve('/(console)/commands/[id=uuid]', { id: shown.runId })}
				onclick={() => (shown = null)}>Review</a
			>
		{:else}
			<a
				class="review"
				href={resolve('/(console)/approvals/clean-ups/[id=uuid]', { id: shown.requestId })}
				onclick={() => (shown = null)}>Review</a
			>
		{/if}
		<button
			type="button"
			class="dismiss"
			data-raw-button="icon"
			aria-label="Dismiss"
			onclick={() => (shown = null)}
		>
			<IconX size={18} />
		</button>
	</div>
{/if}

<style>
	.notice {
		position: fixed;
		left: 50%;
		bottom: calc(var(--tabbar-height) + var(--space-4) + var(--safe-bottom));
		z-index: 31;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: min(28rem, calc(100vw - 32px));
		padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-popover);
		font-size: var(--text-sm);
		transform: translateX(-50%);
	}

	.message {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.review {
		display: inline-flex;
		align-items: center;
		min-height: 40px;
		padding: 0 var(--space-4);
		border-radius: var(--radius-pill);
		background: var(--brand);
		color: var(--brand-contrast);
		font-weight: var(--weight-semibold);
	}

	.dismiss {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: none;
		border-radius: var(--radius-pill);
		background: none;
		color: var(--muted);
		cursor: pointer;
	}

	@media (min-width: 900px) {
		.notice {
			bottom: calc(var(--space-6) + var(--safe-bottom));
		}
	}
</style>
