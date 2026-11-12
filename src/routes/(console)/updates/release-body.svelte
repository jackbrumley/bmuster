<script lang="ts">
	import { parseReleaseMarkdown, type Inline } from '#lib/domain/releases/release-markdown.ts';

	/** A GitHub release body, drawn from its Markdown as components (SU15). */
	let { body }: { body: string } = $props();

	const blocks = $derived(parseReleaseMarkdown(body));
</script>

{#snippet line(runs: Inline[])}
	{#each runs as run, index (index)}
		{#if run.kind === 'bold'}<strong>{run.text}</strong>{:else if run.kind === 'code'}<code
				>{run.text}</code
			>{:else if run.kind === 'link'}<a
				href={run.href}
				target="_blank"
				rel="external noopener noreferrer">{run.text}</a
			>{:else}{run.text}{/if}
	{/each}
{/snippet}

<div class="body">
	{#each blocks as block, index (index)}
		{#if block.kind === 'heading'}
			{#if block.level === 2}<h4>{@render line(block.content)}</h4>{:else}<h5>
					{@render line(block.content)}
				</h5>{/if}
		{:else if block.kind === 'list'}
			<ul>
				{#each block.items as item, itemIndex (itemIndex)}<li>{@render line(item)}</li>{/each}
			</ul>
		{:else}
			<p>{@render line(block.content)}</p>
		{/if}
	{/each}
</div>

<style>
	.body {
		display: grid;
		gap: var(--space-2);
		overflow-wrap: anywhere;
	}

	h4,
	h5 {
		margin: var(--space-2) 0 0;
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	ul {
		display: grid;
		gap: var(--space-1);
		margin: 0;
		padding-left: var(--space-5);
	}

	p {
		margin: 0;
	}

	code {
		font-family: var(--font-mono);
		font-size: var(--text-sm);
	}
</style>
