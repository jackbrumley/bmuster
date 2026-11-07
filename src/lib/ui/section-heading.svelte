<script lang="ts">
	/**
	 * The small uppercase heading at the top of a panel or list ("Health",
	 * "Danger zone"). Panel and ListCard render it; a page never styles its own.
	 */
	let { id, text, tone }: { id: string; text: string; tone: 'normal' | 'danger' } = $props();
</script>

<h2 {id} class="section-heading {tone}">{text}</h2>

<style>
	.section-heading {
		color: var(--muted);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}

	.danger {
		color: var(--danger);
	}
</style>
