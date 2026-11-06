<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IconBrandWindows, IconShieldLock } from '@tabler/icons-svelte-runes';
	import PublicPage from '#lib/shell/public-page.svelte';
	import type { PageProps } from './$types';

	/** PROTOTYPE: every button signs you in straight away. */
	let { data }: PageProps = $props();

	let username = $state('');
	let password = $state('');

	async function signIn(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		await goto(resolve('/(console)'));
	}
</script>

<svelte:head>
	<title>Sign in · BMuster</title>
</svelte:head>

<PublicPage>
	<h1>Sign in</h1>

	{#if data.providers.length > 0}
		<div class="providers">
			{#each data.providers as provider (provider.id)}
				<a class="provider" href={resolve('/(console)')}>
					{#if provider.kind === 'microsoft-entra'}
						<IconBrandWindows size={20} />
					{:else}
						<IconShieldLock size={20} />
					{/if}
					Continue with {provider.name}
				</a>
			{/each}
		</div>
		<p class="divider"><span>or with a password</span></p>
	{/if}

	<form class="form" onsubmit={signIn}>
		<label>
			<span>Email or username</span>
			<input autocomplete="username" autocapitalize="off" bind:value={username} required />
		</label>
		<label>
			<span>Password</span>
			<input type="password" autocomplete="current-password" bind:value={password} required />
		</label>
		<button type="submit" class="primary">Sign in</button>
	</form>
</PublicPage>

<style>
	h1 {
		margin-bottom: var(--space-6);
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		text-align: center;
	}

	.providers {
		display: grid;
		gap: var(--space-2);
	}

	.provider {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		height: 48px;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-pill);
		color: var(--text);
		font-weight: var(--weight-semibold);
	}

	.provider:hover {
		background: var(--surface-muted);
	}

	.divider {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		margin: var(--space-6) 0;
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.divider::before,
	.divider::after {
		content: '';
		flex: 1;
		height: 1px;
		background: var(--border);
	}

	.form {
		display: grid;
		gap: var(--space-4);
	}

	label {
		display: grid;
		gap: var(--space-1);
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}

	input {
		height: 48px;
		padding: 0 var(--space-3);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-control);
		background: var(--surface);
		color: var(--text);
		font-size: var(--text-base);
	}

	.primary {
		height: 48px;
		border: none;
		border-radius: var(--radius-pill);
		background: var(--brand);
		color: var(--brand-contrast);
		font-weight: var(--weight-semibold);
		cursor: pointer;
	}

	.primary:hover {
		background: var(--brand-hover);
	}
</style>
