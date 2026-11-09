<script lang="ts">
	import { onMount } from 'svelte';
	import { IconCheck, IconCopy } from '@tabler/icons-svelte-runes';
	import { detectComputer, type DetectedComputer } from '#lib/domain/machines/phone-support.ts';
	import type { JoinInstallReply } from '#lib/schemas/machines/support-codes.ts';
	import Button from '#lib/ui/button.svelte';
	import ChipGroup from '#lib/ui/chip-group.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import RadarSpinner from '#lib/ui/radar-spinner.svelte';
	import { copyText } from '#lib/utils/clipboard.ts';

	/**
	 * The install command (SPEC-JOIN J9): the computer guessed from the
	 * browser, tabs for each OS the server has an agent for (macOS: not yet),
	 * the command with a big Copy button, and plain steps.
	 */
	let {
		commands,
		supportPerson
	}: {
		commands: JoinInstallReply;
		supportPerson: string;
	} = $props();

	type Os = 'windows' | 'linux' | 'macos';

	let detected = $state<DetectedComputer>('windows');
	let chosen = $state<Os | null>(null);
	let copied = $state<{ kind: 'no' } | { kind: 'yes' } | { kind: 'failed'; reason: string }>({
		kind: 'no'
	});

	const tabs = $derived(
		[
			{ value: 'windows' as const, label: 'Windows', count: undefined },
			{ value: 'linux' as const, label: 'Linux', count: undefined },
			{ value: 'macos' as const, label: 'Mac', count: undefined }
		].filter((tab) => tab.value === 'macos' || commands[tab.value].kind === 'ready')
	);

	/** The tab shown until the caller picks one: the detected computer when it is offered. */
	const fallback = $derived.by((): Os => {
		const wanted: Os = detected === 'phone' ? 'windows' : detected;
		return tabs.some((tab) => tab.value === wanted) ? wanted : (tabs[0]?.value ?? 'macos');
	});
	const os = $derived(chosen ?? fallback);
	const command = $derived(os === 'macos' ? undefined : commands[os]);
	const anyReady = $derived(commands.linux.kind === 'ready' || commands.windows.kind === 'ready');

	onMount(() => {
		detected = detectComputer(navigator.userAgent);
	});

	async function copy(text: string): Promise<void> {
		const result = await copyText(text);
		copied = result.ok ? { kind: 'yes' } : { kind: 'failed', reason: result.reason };
	}
</script>

<div class="step">
	<h1>Install the helper</h1>

	{#if detected === 'phone'}
		<Notice tone="info" title="Use the computer you need help with">
			<p>Open this page on that computer, so you can copy the command there.</p>
		</Notice>
	{/if}

	{#if !anyReady}
		<p class="plain">This server can’t add computers yet. Tell {supportPerson}.</p>
	{:else}
		<ChipGroup
			label="Your computer"
			options={tabs}
			bind:value={
				() => os,
				(value: Os | null) => {
					chosen = value;
					copied = { kind: 'no' };
				}
			}
		/>

		{#if os === 'macos'}
			<p class="plain">Mac computers are not available yet. Tell {supportPerson}.</p>
		{:else if command?.kind === 'ready'}
			<ol class="steps">
				{#if os === 'windows'}
					<li>Right-click the <strong>Start</strong> button.</li>
					<li>
						Choose <strong>Terminal (Admin)</strong> or <strong>Windows PowerShell (Admin)</strong>.
					</li>
					<li>Click <strong>Yes</strong>.</li>
					<li>Copy the command below, then right-click in the window to paste it.</li>
					<li>Press <strong>Enter</strong>.</li>
				{:else}
					<li>Open <strong>Terminal</strong>.</li>
					<li>Copy the command below, then paste it (<strong>Ctrl+Shift+V</strong>).</li>
					<li>Press <strong>Enter</strong>.</li>
					<li>
						Type your password and press <strong>Enter</strong>. You won’t see it as you type.
					</li>
				{/if}
			</ol>
			<code class="command">{command.command}</code>
			<Button
				variant="primary"
				size="large"
				type="button"
				onclick={() => {
					void copy(command.command);
				}}
			>
				{#if copied.kind === 'yes'}
					<IconCheck size={22} /> Copied
				{:else}
					<IconCopy size={22} /> Copy command
				{/if}
			</Button>
			{#if copied.kind === 'failed'}
				<p class="problem" role="alert">
					This browser did not allow copying ({copied.reason}). Select the command and copy it.
				</p>
			{/if}
		{/if}
	{/if}

	<p class="waiting" aria-live="polite">
		<RadarSpinner size="small" /> Waiting for your computer to connect…
	</p>
</div>

<style>
	.step {
		display: grid;
		gap: var(--space-4);
	}

	h1 {
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		text-align: center;
	}

	.plain {
		font-size: var(--text-lg);
	}

	.steps {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding-left: var(--space-5);
		font-size: var(--text-base);
		line-height: 1.4;
	}

	.command {
		display: block;
		padding: var(--space-3);
		border: 1px solid var(--border);
		border-radius: var(--radius-control);
		background: var(--surface);
		font-family: var(--font-mono);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
		white-space: pre-wrap;
		user-select: all;
	}

	.problem {
		color: var(--danger);
		font-size: var(--text-sm);
	}

	.waiting {
		color: var(--muted);
		font-size: var(--text-sm);
		text-align: center;
	}
</style>
