<script lang="ts">
	import Button from '#lib/ui/button.svelte';
	import { page } from '$app/state';
	import {
		IconBrandApple,
		IconBrandUbuntu,
		IconBrandWindows,
		IconKey,
		IconRefresh
	} from '@tabler/icons-svelte-runes';
	import CopyField from '#lib/ui/copy-field.svelte';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { createJoinCodeReplySchema } from '#lib/schemas/machines/join-codes.ts';
	import type { OsFamily } from '#lib/domain/machines/machine.ts';

	type CodeState =
		| { kind: 'none' }
		| { kind: 'making' }
		| { kind: 'ready'; code: string; expiresAtIso: string }
		| { kind: 'failed'; message: string };

	let joinCode = $state<CodeState>({ kind: 'none' });
	let target = $state<OsFamily>('linux');

	const origin = $derived(page.url.origin);

	function commandFor(code: string): string {
		switch (target) {
			case 'linux':
			case 'macos':
				return `curl -fsSL ${origin}/install.sh | sudo sh -s -- --code ${code}`;
			case 'windows':
				return `& ([scriptblock]::Create((irm ${origin}/install.ps1))) -Code ${code}`;
		}
	}

	const targets: { id: OsFamily; label: string; icon: typeof IconBrandUbuntu }[] = [
		{ id: 'linux', label: 'Linux', icon: IconBrandUbuntu },
		{ id: 'windows', label: 'Windows', icon: IconBrandWindows },
		{ id: 'macos', label: 'macOS', icon: IconBrandApple }
	];

	async function makeCode(): Promise<void> {
		joinCode = { kind: 'making' };
		const result = await apiRequest({
			method: 'POST',
			url: '/api/join-codes',
			body: { maxUses: 1, minutes: 60 },
			reply: createJoinCodeReplySchema
		});
		joinCode = result.ok
			? { kind: 'ready', code: result.data.code, expiresAtIso: result.data.expiresAtIso }
			: { kind: 'failed', message: result.message };
	}

	function expiryTime(iso: string): string {
		return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
	}
</script>

<header class="page-head">
	<h1>Add a machine</h1>
	<p class="sub">
		Run one command on the machine. It joins this server and shows up under Machines.
	</p>
</header>

<section class="panel">
	<div class="code-row">
		<div>
			<p class="label">Join code</p>
			{#if joinCode.kind === 'ready'}
				<p class="code">{joinCode.code}</p>
				<p class="hint">Works once. Expires at {expiryTime(joinCode.expiresAtIso)}.</p>
			{:else if joinCode.kind === 'failed'}
				<p class="error">{joinCode.message}</p>
			{:else}
				<p class="hint">A code lets one machine join, once, within 60 minutes.</p>
			{/if}
		</div>
		<Button
			variant={joinCode.kind === 'ready' ? 'secondary' : 'primary'}
			size="compact"
			type="button"
			onclick={() => {
				void makeCode();
			}}
		>
			{#if joinCode.kind === 'ready'}
				<IconRefresh size={18} /> New code
			{:else}
				<IconKey size={18} /> {joinCode.kind === 'making' ? 'Making…' : 'Make a join code'}
			{/if}
		</Button>
	</div>

	<div class="targets" role="group" aria-label="Operating system">
		{#each targets as item (item.id)}
			<button
				data-raw-button="card"
				type="button"
				class="target"
				aria-pressed={target === item.id}
				onclick={() => (target = item.id)}
			>
				<item.icon size={20} stroke={1.75} />
				{item.label}
			</button>
		{/each}
	</div>

	{#if target === 'macos'}
		<p class="hint">The macOS agent is not built yet.</p>
	{:else if joinCode.kind === 'ready'}
		<div class="step">
			<p class="label">
				{target === 'windows' ? 'Run in PowerShell as administrator' : 'Run in a terminal'}
			</p>
			<CopyField value={commandFor(joinCode.code)} label="install command" />
		</div>
	{/if}
</section>

<style>
	.page-head {
		display: grid;
		gap: var(--space-1);
		margin-bottom: var(--space-4);
	}

	h1 {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
	}

	.sub {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.panel {
		display: grid;
		/* minmax(0, …): the long install command scrolls inside its field instead of widening the card. */
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-6);
		max-width: 44rem;
		padding: var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-card);
	}

	.code-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
	}

	.label {
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.code {
		font-family: var(--font-mono);
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-caps);
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.error {
		color: var(--danger);
		font-size: var(--text-sm);
	}

	.targets {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-2);
	}

	.target {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		height: 44px;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface);
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		cursor: pointer;
	}

	.target[aria-pressed='true'] {
		border-color: var(--brand);
		background: var(--brand-tint);
		color: var(--brand);
	}

	.step {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-2);
	}
</style>
