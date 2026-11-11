<script lang="ts">
	import { IconHandStop } from '@tabler/icons-svelte-runes';
	import { textWithLinks } from '#lib/domain/machines/phone-support.ts';
	import Button from '#lib/ui/button.svelte';

	/**
	 * The scam check's stop screen (SPEC-JOIN J8). The stop is already
	 * recorded; Go back returns to the questions for a caller who misclicked.
	 */
	let { reportAdvice, back }: { reportAdvice: string; back: () => void } = $props();

	const advice = $derived(
		textWithLinks(reportAdvice).map((part, index) => ({ ...part, key: index }))
	);
</script>

<div class="step" role="alert">
	<div class="title">
		<IconHandStop size={40} stroke={1.75} />
		<h1>Stop. This looks like a scam.</h1>
	</div>
	<ul class="actions">
		<li>If you are on a call, hang up.</li>
		<li>Don’t enrol this computer or install anything.</li>
		<li>If you shared bank details or passwords, call your bank now.</li>
	</ul>
	<p class="report">
		{#each advice as part (part.key)}
			{#if part.kind === 'link'}
				<a href={part.href} target="_blank" rel="external noopener noreferrer">{part.href}</a>
			{:else}
				{part.text}
			{/if}
		{/each}
	</p>
	<Button variant="secondary" size="large" type="button" onclick={back}>Go back</Button>
</div>

<style>
	.step {
		display: grid;
		gap: var(--space-5);
	}

	.title {
		display: grid;
		justify-items: center;
		gap: var(--space-2);
		color: var(--danger);
		text-align: center;
	}

	h1 {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
	}

	.actions {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding-left: var(--space-5);
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}

	.report {
		font-size: var(--text-base);
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	a {
		color: var(--brand);
	}
</style>
