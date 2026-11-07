<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IconBrandWindows, IconShieldLock } from '@tabler/icons-svelte-runes';
	import PublicPage from '#lib/shell/public-page.svelte';
	import Button from '#lib/ui/button.svelte';
	import TextField from '#lib/ui/text-field.svelte';
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
		<TextField
			label="Email or username"
			type="text"
			autocomplete="username"
			autocapitalize="off"
			required={true}
			bind:value={username}
		/>
		<TextField
			label="Password"
			type="password"
			autocomplete="current-password"
			autocapitalize="off"
			required={true}
			bind:value={password}
		/>
		<Button variant="primary" size="large" type="submit" onclick={undefined}>Sign in</Button>
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
</style>
