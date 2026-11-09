<script lang="ts">
	import { onDestroy } from 'svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { copyText } from '#lib/utils/clipboard.ts';
	import { IconCheck, IconCopy, IconEye, IconEyeOff } from '@tabler/icons-svelte-runes';
	import type { LocalPageInfo } from '#lib/domain/machines/local-page.ts';
	import { localCodeReplySchema } from '#lib/schemas/machines/local-page.ts';
	import Button from '#lib/ui/button.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import CopyField from '#lib/ui/copy-field.svelte';
	import RadarSpinner from '#lib/ui/radar-spinner.svelte';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * The agent's local page (SPEC-AGENT-LOCAL): where to open it on the machine,
	 * its certificate to check the browser warning against, and the sign-in code
	 * (admins), which changes every 30 seconds. Each person sees their own code
	 * (SPEC-AGENT-LOCAL 7); an older agent still takes one shared code. Viewing
	 * the code is audited.
	 */
	let { machineId, localPage }: { machineId: string; localPage: LocalPageInfo } = $props();

	type CodeState =
		| { kind: 'hidden' }
		| { kind: 'loading' }
		| { kind: 'shown'; code: string; secondsLeft: number; scope: 'person' | 'machine' }
		| { kind: 'not-reported' }
		| { kind: 'not-listed' }
		| { kind: 'failed'; message: string };

	let codeState = $state<CodeState>({ kind: 'hidden' });
	let copied = $state(false);

	async function copyCode(code: string): Promise<void> {
		const result = await copyText(code);
		if (!result.ok) {
			showToast(`This browser did not allow copying (${result.reason}).`, 'error');
			return;
		}
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
					secondsLeft: result.data.secondsLeft,
					scope: result.data.scope
				};
				break;
			case 'not-reported':
				stopTicking();
				codeState = { kind: 'not-reported' };
				break;
			case 'not-listed':
				stopTicking();
				codeState = { kind: 'not-listed' };
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
		<Notice tone="warning" title="This agent is too old for the local page">
			<p>
				Newer agents serve a page on the machine itself for checking and fixing the agent, even
				while the internet is down. This one was installed before that. Reinstall it once with
				Reinstall agent below: it keeps this machine's name, notes and history, and from then on it
				updates itself.
			</p>
		</Notice>
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
				<p class="muted"><RadarSpinner size="small" /> Getting the code</p>
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
					{#if codeState.scope === 'person'}
						<p class="muted">
							Your own code: Activity records when it signs in and what is done with it.
						</p>
					{:else}
						<p class="warning">
							A shared code: every admin sees this one, so Activity cannot say who used it. Update
							the agent to give each person their own code.
						</p>
					{/if}
					<p class="muted">
						Changes in {codeState.secondsLeft} s; the next one appears here. Viewing it is recorded in
						Activity.
					</p>
					<Button variant="secondary" size="compact" type="button" onclick={hideCode}
						><IconEyeOff size={18} /> Hide code</Button
					>
				</div>
			{:else if codeState.kind === 'not-reported'}
				<Notice tone="warning" title="This agent has not reported its local page">
					<p>Reinstall it once with Reinstall agent below to get the local page.</p>
				</Notice>
			{:else if codeState.kind === 'not-listed'}
				<p class="muted">
					You are not one of the people who may sign in to this machine's local page.
				</p>
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

	.warning {
		color: var(--warning);
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
