<script lang="ts">
	import { page } from '$app/state';
	import {
		IconBrandApple,
		IconBrandUbuntu,
		IconBrandWindows,
		IconRefresh
	} from '@tabler/icons-svelte-runes';
	import CopyField from '#lib/ui/copy-field.svelte';
	import type { OsFamily } from '#lib/domain/machines/machine.ts';

	/** PROTOTYPE: the join code is made up here; the server issues real ones. */
	let joinCode = $state('K7P-4QX-29M');
	let target = $state<OsFamily>('linux');

	const origin = $derived(page.url.origin);

	const command = $derived.by(() => {
		switch (target) {
			case 'linux':
			case 'macos':
				return `curl -fsSL ${origin}/install.sh | sudo sh -s -- --code ${joinCode}`;
			case 'windows':
				return `& ([scriptblock]::Create((irm ${origin}/install.ps1))) -Code ${joinCode}`;
		}
	});

	const targets: { id: OsFamily; label: string; icon: typeof IconBrandUbuntu }[] = [
		{ id: 'linux', label: 'Linux', icon: IconBrandUbuntu },
		{ id: 'windows', label: 'Windows', icon: IconBrandWindows },
		{ id: 'macos', label: 'macOS', icon: IconBrandApple }
	];

	function newCode(): void {
		const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
		const part = (): string =>
			Array.from({ length: 3 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(
				''
			);
		joinCode = `${part()}-${part()}-${part()}`;
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
			<p class="code">{joinCode}</p>
			<p class="hint">Works once. Expires in 60 minutes.</p>
		</div>
		<button type="button" class="secondary" onclick={newCode}
			><IconRefresh size={18} /> New code</button
		>
	</div>

	<div class="targets" role="group" aria-label="Operating system">
		{#each targets as item (item.id)}
			<button
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

	<div class="step">
		<p class="label">
			{target === 'windows' ? 'Run in PowerShell as administrator' : 'Run in a terminal'}
		</p>
		<CopyField value={command} label="install command" />
	</div>
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

	.secondary {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		background: var(--surface-elevated);
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		cursor: pointer;
	}

	.targets {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
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
		gap: var(--space-2);
	}
</style>
