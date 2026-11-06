<script lang="ts">
	import { IconBrandWindows, IconKey, IconPlus, IconShieldLock } from '@tabler/icons-svelte-runes';
	import PageHeader from '#lib/ui/page-header.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<PageHeader
	title="Sign-in"
	summary="How people prove who they are. Access is still set by groups and rules."
	actions={undefined}
/>

<section class="panel">
	<div class="panel-head">
		<h2>Identity providers</h2>
		<button type="button" class="secondary"><IconPlus size={18} /> Add provider</button>
	</div>
	<ul class="list">
		{#each data.providers as provider (provider.id)}
			<li class="row">
				<span class="icon">
					{#if provider.kind === 'microsoft-entra'}
						<IconBrandWindows size={20} />
					{:else}
						<IconShieldLock size={20} />
					{/if}
				</span>
				<div class="body">
					<p class="name">{provider.name}</p>
					<p class="meta">OpenID Connect · sign-in code flow with PKCE</p>
				</div>
				<span class="state" class:on={provider.enabled}>{provider.enabled ? 'On' : 'Off'}</span>
			</li>
		{/each}
	</ul>
</section>

<section class="panel">
	<div class="panel-head">
		<h2>Password sign-in</h2>
	</div>
	<p class="row-text">
		<IconKey size={18} />
		Admins can always sign in with a password, so a broken provider never locks you out. Other people
		use a password only if an admin gives them one.
	</p>
</section>

<style>
	.panel {
		display: grid;
		gap: var(--space-3);
		margin-bottom: var(--space-4);
		padding: var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-card);
	}

	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	h2 {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
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

	.list {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) 0;
	}

	.row + .row {
		border-top: 1px solid var(--border);
	}

	.icon {
		display: inline-flex;
		color: var(--text-soft);
	}

	.body {
		flex: 1;
	}

	.name {
		font-weight: var(--weight-semibold);
	}

	.meta {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.state {
		padding: 2px var(--space-3);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
	}

	.state.on {
		background: var(--success-bg);
		color: var(--success);
	}

	.row-text {
		display: flex;
		gap: var(--space-3);
		color: var(--text-soft);
		font-size: var(--text-sm);
	}
</style>
