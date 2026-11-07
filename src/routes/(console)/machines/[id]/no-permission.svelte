<script lang="ts">
	import { IconLock } from '@tabler/icons-svelte-runes';

	/** Shown on a machine tab the person's access rules do not allow (SPEC-ACCESS A6). */
</script>

<div class="notice">
	<IconLock size={32} />
	<p>You don't have permission for this.</p>
	<p class="hint">An admin can give your group this permission in an access rule.</p>
</div>

<style>
	.notice {
		display: grid;
		justify-items: center;
		gap: var(--space-3);
		padding: var(--space-12) var(--space-4);
		color: var(--muted);
		text-align: center;
	}

	.hint {
		font-size: var(--text-sm);
	}
</style>
