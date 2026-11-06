<script lang="ts">
	import { IconCheck, IconCopy } from '@tabler/icons-svelte-runes';

	/** A read-only line of text (a command or a code) with a copy button. */
	let { value, label }: { value: string; label: string } = $props();

	let copied = $state(false);

	async function copy(): Promise<void> {
		await navigator.clipboard.writeText(value);
		copied = true;
		setTimeout(() => {
			copied = false;
		}, 1500);
	}
</script>

<div class="field">
	<code>{value}</code>
	<button type="button" class="copy" aria-label="Copy {label}" onclick={copy}>
		{#if copied}
			<IconCheck size={18} />
		{:else}
			<IconCopy size={18} />
		{/if}
	</button>
</div>

<style>
	.field {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-2) var(--space-2) var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--surface);
	}

	code {
		flex: 1;
		min-width: 0;
		overflow-x: auto;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		color: var(--text);
		scrollbar-width: none;
	}

	.copy {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		flex-shrink: 0;
		border: none;
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--text-soft);
		cursor: pointer;
	}

	.copy:hover {
		background: var(--brand-tint);
		color: var(--brand);
	}
</style>
