<script lang="ts">
	import Panel from '#lib/ui/panel.svelte';
	import { linuxDisplayFacts, type DisplayReport } from '#lib/domain/machines/display-report.ts';

	/**
	 * Overview → Display (SPEC-AGENT-LOGS 3): what a remote desktop on this machine depends on,
	 * from the machine report in its latest inventory.
	 */
	let { report }: { report: DisplayReport | undefined } = $props();

	const facts = $derived.by(() => {
		if (report === undefined) {
			return [];
		}
		switch (report.kind) {
			case 'linux':
				return linuxDisplayFacts(report);
			case 'windows':
				return [
					{
						label: 'Console session',
						value: report.console.kind === 'user' ? report.console.name : 'Nobody signed in'
					}
				];
			case 'unsupported':
			case 'unreported':
				return [];
		}
	});

	const note = $derived.by(() => {
		if (report === undefined) {
			return 'Waiting for the first inventory.';
		}
		switch (report.kind) {
			case 'linux':
			case 'windows':
				return undefined;
			case 'unsupported':
				return 'This operating system does not report its display yet.';
			case 'unreported':
				return 'This agent is too old to report its display; update it.';
		}
	});
</script>

<Panel heading="Display" actions={undefined} tone="normal" padding="normal">
	{#if note !== undefined}
		<p class="muted">{note}</p>
	{:else}
		<dl>
			{#each facts as fact (fact.label)}
				<div class="fact">
					<dt>{fact.label}</dt>
					<dd>{fact.value}</dd>
				</div>
			{/each}
		</dl>
	{/if}
</Panel>

<style>
	.muted {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	dl {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
		gap: var(--space-4);
		margin: 0;
	}

	dt {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	dd {
		margin: 0;
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		overflow-wrap: anywhere;
	}
</style>
