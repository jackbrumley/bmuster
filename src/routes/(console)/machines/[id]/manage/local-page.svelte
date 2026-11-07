<script lang="ts">
	import { onDestroy } from 'svelte';
	import { IconCheck, IconCopy, IconEye, IconEyeOff } from '@tabler/icons-svelte-runes';
	import type { LocalPageInfo } from '#lib/domain/machines/local-page.ts';
	import { localCodeReplySchema } from '#lib/schemas/machines/local-page.ts';
	import Button from '#lib/ui/button.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import CopyField from '#lib/ui/copy-field.svelte';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * The agent's local page (SPEC-AGENT-LOCAL): where to open it on the machine,
	 * its certificate to check the browser warning against, and the sign-in code
	 * (admins), which changes every 30 seconds. Viewing the code is audited.
	 */
	let { machineId, localPage }: { machineId: string; localPage: LocalPageInfo } = $props();

	type CodeState =
		| { kind: 'hidden' }
		| { kind: 'loading' }
		| { kind: 'shown'; code: string; secondsLeft: number }
		| { kind: 'not-reported' }
		| { kind: 'failed'; message: string };

	let codeState = $state<CodeState>({ kind: 'hidden' });
	let copied = $state(false);

	async function copyCode(code: string): Promise<void> {
		await navigator.clipboard.writeText(code);
		copied = true;
		setTimeout(() => {
			copied = false;
		}, 1500);
	}
	let ticker: ReturnType<typeof setInterval> | undefined;

	async function fetchCode(): Promise<void> {
		const result = await apiRequest({
			method: 'POST',
			url: `/api/machines/${machineId}/local-code`,
			body: undefined,
			reply: localCodeReplySchema
		});
		if (codeState.kind === 'hidden') {
			return;
		}
		if (!result.ok) {
			stopTicking();
			codeState = { kind: 'failed', message: result.message };
			return;
		}
		switch (result.data.kind) {
			case 'code':
				codeState = {
					kind: 'shown',
					code: result.data.code,
					secondsLeft: result.data.secondsLeft
				};
				break;
			case 'not-reported':
				stopTicking();
				codeState = { kind: 'not-reported' };
				break;
		}
	}

	function tick(): void {
		if (codeState.kind !== 'shown') {
			return;
		}
		const left = codeState.secondsLeft - 1;
		if (left > 0) {
			codeState = { ...codeState, secondsLeft: left };
			return;
		}
		void fetchCode();
	}

	function stopTicking(): void {
		if (ticker !== undefined) {
			clearInterval(ticker);
			ticker = undefined;
		}
	}

	function showCode(): void {
		codeState = { kind: 'loading' };
		stopTicking();
		ticker = setInterval(tick, 1000);
		void fetchCode();
	}

	function hideCode(): void {
		stopTicking();
		codeState = { kind: 'hidden' };
	}

	onDestroy(stopTicking);

	function spaced(code: string): string {
		return `${code.slice(0, 3)} ${code.slice(3)}`;
	}
</script>

<Panel heading="Local page" actions={undefined} tone="normal" padding="normal">
	{#if localPage.kind === 'none'}
		<p class="muted">
			Update the agent to get a local page. Newer agents serve a page on the machine itself for
			checking and fixing the agent, even while the internet is down.
		</p>
	{:else}
		<p class="muted">
			Someone at the machine can open this page to check the agent, test its connection, restart it,
			move it to another server or uninstall it. It works while the internet is down.
		</p>
		<div class="item">
			<p class="label">Open on the machine itself</p>
			<CopyField value={localPage.address} label="local page address" />
		</div>
		<div class="item">
			<p class="label">Certificate SHA-256 (check the browser warning against it)</p>
			<code class="fingerprint">{localPage.fingerprint}</code>
		</div>
		<div class="item" aria-live="polite">
			<p class="label">Sign-in code</p>
			{#if codeState.kind === 'hidden'}
				<div>
					<Button variant="secondary" size="compact" type="button" onclick={showCode}
						><IconEye size={18} /> Show local page code</Button
					>
				</div>
			{:else if codeState.kind === 'loading'}
				<p class="muted">Getting the code…</p>
			{:else if codeState.kind === 'shown'}
				<div class="shown">
					<div class="code-row">
						<p class="code">{spaced(codeState.code)}</p>
						<button
							data-raw-button="icon"
							type="button"
							class="copy"
							aria-label="Copy the sign-in code"
							onclick={() => copyCode(codeState.kind === 'shown' ? codeState.code : '')}
						>
							{#if copied}
								<IconCheck size={20} />
							{:else}
								<IconCopy size={20} />
							{/if}
						</button>
					</div>
					<p class="muted">
						Changes in {codeState.secondsLeft} s; the next one appears here. Viewing it is recorded in
						Activity.
					</p>
					<Button variant="secondary" size="compact" type="button" onclick={hideCode}
						><IconEyeOff size={18} /> Hide code</Button
					>
				</div>
			{:else if codeState.kind === 'not-reported'}
				<p class="muted">Update the agent to get a local page.</p>
			{:else}
				<p class="error">{codeState.message}</p>
				<div>
					<Button variant="secondary" size="compact" type="button" onclick={showCode}
						><IconEye size={18} /> Try again</Button
					>
				</div>
			{/if}
		</div>
	{/if}
</Panel>

<style>
	.muted {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.error {
		color: var(--danger);
		font-size: var(--text-sm);
	}

	.item {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-1);
	}

	.label {
		color: var(--text-soft);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.fingerprint {
		font-family: var(--font-mono);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}

	.shown {
		display: grid;
		justify-items: center;
		gap: var(--space-2);
		text-align: center;
	}

	.code-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	/* Same as CopyField's button. */
	.copy {
		display: inline-grid;
		place-items: center;
		width: 40px;
		height: 40px;
		border: none;
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--text-soft);
		cursor: pointer;
	}

	.copy:hover {
		color: var(--text);
	}

	.code {
		font-family: var(--font-mono);
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-caps);
		font-variant-numeric: tabular-nums;
	}
</style>
