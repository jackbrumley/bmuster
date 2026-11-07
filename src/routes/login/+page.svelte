<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { IconBrandWindows, IconShieldLock } from '@tabler/icons-svelte-runes';
	import PublicPage from '#lib/shell/public-page.svelte';
	import Button from '#lib/ui/button.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import type { PageProps } from './$types';

	/** Password, or "Continue with" each enabled provider (SPEC-SIGN-IN 3). */
	let { data, form }: PageProps = $props();

	let email = $state('');
	let password = $state('');
</script>

<svelte:head>
	<title>Sign in · BMuster</title>
</svelte:head>

<PublicPage>
	<h1>Sign in</h1>

	{#if data.providers.length > 0}
		<div class="providers">
			{#each data.providers as provider (provider.id)}
				<form
					method="GET"
					action={resolve('/auth/oidc/[id=uuid]/start', { id: provider.id })}
					data-sveltekit-reload
				>
					<input type="hidden" name="returnTo" value={data.returnTo} />
					<Button variant="secondary" size="large" type="submit" onclick={undefined}>
						{#if provider.kind === 'microsoft-entra'}
							<IconBrandWindows size={20} />
						{:else}
							<IconShieldLock size={20} />
						{/if}
						Continue with {provider.name}
					</Button>
				</form>
			{/each}
		</div>
		<p class="divider"><span>or with a password</span></p>
	{/if}

	<form
		class="form"
		method="POST"
		use:enhance={() =>
			async ({ update }) => {
				password = '';
				await update({ reset: false });
			}}
	>
		{#if form?.message !== undefined}
			<p class="problem" role="alert">{form.message}</p>
		{/if}
		<TextField
			label="Email"
			name="email"
			type="email"
			autocomplete="username"
			autocapitalize="off"
			required={true}
			error={undefined}
			bind:value={email}
		/>
		<TextField
			label="Password"
			name="password"
			type="password"
			autocomplete="current-password"
			autocapitalize="off"
			required={true}
			error={undefined}
			bind:value={password}
		/>
		<Button variant="primary" size="large" type="submit" onclick={undefined}>Sign in</Button>
	</form>
	{#if data.canResetByEmail}
		<p class="forgot"><a href={resolve('/login/forgot')}>Forgot your password?</a></p>
	{/if}
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

	.forgot {
		margin-top: var(--space-4);
		font-size: var(--text-sm);
		text-align: center;
	}

	.forgot a {
		color: var(--brand);
	}

	.problem {
		padding: var(--space-3);
		border-radius: var(--radius-control);
		background: var(--danger-bg);
		color: var(--danger);
		font-size: var(--text-sm);
	}
</style>
