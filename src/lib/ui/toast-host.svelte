<script lang="ts">
	import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-svelte-runes';
	import { toasts } from './toast.svelte.ts';
</script>

<div class="host" aria-live="polite">
	{#each toasts.list as toast (toast.id)}
		<p
			class="toast"
			class:error={toast.tone === 'error'}
			role={toast.tone === 'error' ? 'alert' : 'status'}
		>
			{#if toast.tone === 'error'}
				<IconAlertTriangle size={18} />
			{:else}
				<IconCircleCheck size={18} />
			{/if}
			{toast.message}
		</p>
	{/each}
</div>

<style>
	.host {
		position: fixed;
		left: 50%;
		bottom: calc(var(--tabbar-height) + var(--space-4) + var(--safe-bottom));
		z-index: 30;
		display: grid;
		gap: var(--space-2);
		width: min(26rem, calc(100vw - 32px));
		transform: translateX(-50%);
		pointer-events: none;
	}

	.toast {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-overlay);
		color: var(--success);
		font-size: var(--text-sm);
		box-shadow: var(--shadow-popover);
	}

	.toast.error {
		color: var(--danger);
	}

	@media (min-width: 900px) {
		.host {
			bottom: calc(var(--space-6) + var(--safe-bottom));
		}
	}
</style>
