<script lang="ts">
	import { IconBookmark } from '@tabler/icons-svelte-runes';
	import { savedEffectLabel, type SavedRunMark } from '#lib/domain/commands/saved-commands.ts';

	/**
	 * The saved command a run came from (SPEC-SAVED-COMMANDS SC14), on the runs list and a run's
	 * results: its name and version, the admin's label (Changes the machine in the warning colour),
	 * and whether an assistant ran it with no person approving. Nothing for a typed command.
	 */
	let { mark }: { mark: SavedRunMark } = $props();
</script>

{#if mark.kind === 'saved'}
	<span class="tag">
		<span class="name">
			<IconBookmark size={14} aria-hidden="true" />
			Saved command: {mark.name} (version {mark.version})
		</span>
		<span class="label" class:changes={mark.effect === 'changes'}>
			{savedEffectLabel(mark.effect)}
		</span>
		{#if mark.preApproved}
			<span class="label" class:changes={mark.effect === 'changes'}>Ran without approval</span>
		{/if}
	</span>
{/if}

<style>
	.tag {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-2);
		min-width: 0;
		font-size: var(--text-xs);
	}

	.name {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		color: var(--text-soft);
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.label {
		padding: var(--space-0-5) var(--space-2);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--muted);
		font-weight: var(--weight-semibold);
	}

	.changes {
		background: var(--warning-bg);
		color: var(--warning);
	}
</style>
