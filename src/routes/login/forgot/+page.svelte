<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { IconMailCheck } from '@tabler/icons-svelte-runes';
	import PublicPage from '#lib/shell/public-page.svelte';
	import Button from '#lib/ui/button.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import type { PageProps } from './$types';

	/**
	 * Forgot password (SPEC-EMAIL E4). After sending, the page says the same
	 * thing whether or not the address has an account.
	 */
	let { data, form }: PageProps = $props();

	let email = $state('');
</script>

<svelte:head>
	<title>Forgot password · BMuster</title>
</svelte:head>

<PublicPage width="compact">
	<h1>Forgot your password?</h1>
	{#if form !== null && 'sent' in form}
		<div class="sent" role="status">
			<IconMailCheck size={40} />
			<p>
				If <strong>{form.email}</strong> has a BMuster account, an email is on its way. A reset link works
				once, for 30 minutes. If you sign in with a provider, the email says so instead.
			</p>
		</div>
	{:else if !data.emailReady}
		<p class="intro">
			This server cannot send email yet, so a password cannot be reset from here. Ask an admin to
			reset it for you.
		</p>
	{:else}
		<p class="intro">Enter the email address you sign in with and we will send you a link.</p>
		<form class="form" method="POST" use:enhance>
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
			<Button variant="primary" size="large" type="submit" onclick={undefined}>
				Send reset link
			</Button>
		</form>
	{/if}
	<p class="back"><a href={resolve('/login')}>Back to sign in</a></p>
</PublicPage>

<style>
	h1 {
		margin-bottom: var(--space-2);
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		text-align: center;
	}

	.intro {
		margin-bottom: var(--space-6);
		color: var(--muted);
		font-size: var(--text-sm);
		text-align: center;
	}

	.form {
		display: grid;
		gap: var(--space-4);
	}

	.sent {
		display: grid;
		justify-items: center;
		gap: var(--space-3);
		margin-top: var(--space-4);
		color: var(--brand);
		text-align: center;
	}

	.sent p {
		color: var(--text);
		font-size: var(--text-sm);
	}

	.problem {
		padding: var(--space-3);
		border-radius: var(--radius-control);
		background: var(--danger-bg);
		color: var(--danger);
		font-size: var(--text-sm);
	}

	.back {
		margin-top: var(--space-6);
		font-size: var(--text-sm);
		text-align: center;
	}

	a {
		color: var(--brand);
	}
</style>
