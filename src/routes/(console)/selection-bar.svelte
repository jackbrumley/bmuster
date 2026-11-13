<script lang="ts">
	import { IconTerminal2 } from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';

	/**
	 * The bar fixed to the bottom of the screen while machines are ticked (SPEC-COMMANDS C4):
	 * the full count (ticked machines the chips hide too), Clear and Run command. Above the
	 * phone tab bar; on wide screens beside the sidebar.
	 */
	let { count, onclear, onrun }: { count: number; onclear: () => void; onrun: () => void } =
		$props();
</script>

<section class="bar" aria-label="Selected machines">
	<p class="count">{count} selected</p>
	<div class="actions">
		<Button variant="secondary" size="compact" type="button" onclick={onclear}>Clear</Button>
		<Button variant="primary" size="compact" type="button" onclick={onrun}>
			<IconTerminal2 size={18} />
			Run command
		</Button>
	</div>
</section>

<!-- Room under the list so the bar never covers its last machine. -->
<div class="room" aria-hidden="true"></div>

<style>
	.bar {
		position: fixed;
		right: calc(var(--page-gutter) + var(--safe-right));
		bottom: calc(var(--tabbar-height) + var(--space-3) + var(--safe-bottom));
		left: calc(var(--page-gutter) + var(--safe-left));
		z-index: 20;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2) var(--space-3);
		padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-overlay);
		box-shadow: var(--shadow-bar);
	}

	.count {
		font-weight: var(--weight-semibold);
		font-variant-numeric: tabular-nums;
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.room {
		height: 72px;
	}

	@media (min-width: 900px) {
		.bar {
			bottom: calc(var(--space-4) + var(--safe-bottom));
			left: calc(var(--sidebar-width) + var(--page-gutter) + var(--safe-left));
		}
	}
</style>
