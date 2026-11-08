<script lang="ts">
	import Button from '#lib/ui/button.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import {
		agentDiagnosticsReplySchema,
		type AgentDiagnosticsReply
	} from '#lib/schemas/agents/diagnostics.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { copyText } from '#lib/utils/clipboard.ts';

	let { machineId }: { machineId: string } = $props();
	let report = $state<AgentDiagnosticsReply | undefined>(undefined);
	let failure = $state<string | undefined>(undefined);
	let loading = $state(false);

	const agentText = $derived(report?.lines.join('\n') ?? '');
	const journalText = $derived.by(() => {
		if (report === undefined) {
			return '';
		}
		switch (report.journal.kind) {
			case 'available':
				return report.journal.lines.join('\n');
			case 'unavailable':
				return `Unavailable: ${report.journal.reason}`;
			case 'unsupported':
				return 'Not available on this operating system.';
		}
	});
	const completeText = $derived(
		report === undefined
			? ''
			: [
					`BMuster diagnostics · agent ${report.agentVersion} · ${report.capturedAtIso}`,
					'=== Agent log (newest last) ===',
					agentText,
					'=== Session startup diagnostics (last 15 minutes) ===',
					journalText
				].join('\n')
	);

	function refresh(): void {
		void load();
	}

	async function load(): Promise<void> {
		loading = true;
		failure = undefined;
		const result = await apiRequest({
			method: 'POST',
			url: `/api/machines/${machineId}/logs`,
			body: undefined,
			reply: agentDiagnosticsReplySchema
		});
		loading = false;
		if (!result.ok) {
			failure = result.message;
			return;
		}
		report = result.data;
	}

	function copyAll(): void {
		void copy();
	}

	async function copy(): Promise<void> {
		const result = await copyText(completeText);
		if (result.ok) {
			showToast('Diagnostics copied.', 'success');
		} else {
			showToast(`This browser did not allow copying (${result.reason}).`, 'error');
		}
	}

	function download(): void {
		const file = new Blob([completeText], { type: 'text/plain;charset=utf-8' });
		const url = URL.createObjectURL(file);
		const link = document.createElement('a');
		link.href = url;
		link.download = `bmuster-${machineId}-diagnostics.txt`;
		link.click();
		URL.revokeObjectURL(url);
	}
</script>

<Panel heading="Recent agent logs" actions={undefined} tone="normal" padding="normal">
	<p class="muted">
		Request the latest agent messages and fixed service startup diagnostics. Terminal output and
		shell history are never collected.
	</p>
	<div class="actions">
		<Button variant="primary" size="compact" type="button" onclick={refresh}>
			{loading ? 'Fetching…' : 'Refresh diagnostics'}
		</Button>
		{#if report !== undefined}
			<Button variant="secondary" size="compact" type="button" onclick={copyAll}>Copy all</Button>
			<Button variant="secondary" size="compact" type="button" onclick={download}
				>Download text</Button
			>
		{/if}
	</div>
	{#if failure !== undefined}
		<p class="failure">
			{failure}{report === undefined ? '' : ' Previous diagnostics are still shown below.'}
		</p>
	{/if}
	{#if report !== undefined}
		<p class="muted">
			Agent {report.agentVersion} · Fetched {new Date(report.capturedAtIso).toLocaleString()}
		</p>
		{#if report.truncated}
			<p class="muted">The agent log was shortened to the newest 200 lines.</p>
		{/if}
		<section aria-label="Agent log">
			<h3>Agent log</h3>
			<pre>{agentText.length > 0 ? agentText : 'No recent agent messages.'}</pre>
		</section>
		<section aria-label="Session startup diagnostics">
			<h3>Session startup diagnostics</h3>
			{#if report.journal.kind === 'available' && report.journal.truncated}
				<p class="muted">The journal output was shortened.</p>
			{/if}
			<pre>{journalText}</pre>
		</section>
	{/if}
</Panel>

<style>
	.muted {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.failure {
		color: var(--danger);
	}

	section {
		display: grid;
		gap: var(--space-2);
		min-width: 0;
	}

	h3 {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	pre {
		max-height: 24rem;
		margin: 0;
		overflow: auto;
		padding: var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--surface);
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
