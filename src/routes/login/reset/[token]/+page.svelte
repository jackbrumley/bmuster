<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import { IconCircleCheck } from '@tabler/icons-svelte-runes';
	import PublicPage from '#lib/shell/public-page.svelte';
	import Button from '#lib/ui/button.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { MIN_PASSWORD_LENGTH } from '#lib/schemas/auth/sign-in.ts';
	import type { PageProps } from './$types';

	/** Choose a new password from a reset link (SPEC-EMAIL E4). */
	let { data, form }: PageProps = $props();

	let password = $state('');
</script>

<svelte:head>
	<title>Choose a new password · BMuster</title>
</svelte:head>

<PublicPage>
	<h1>Choose a new password</h1>
	{#if form !== null && 'done' in form}
		<div class="done" role="status">
			<IconCircleCheck size={40} />
			<p>Your password is changed, and you are signed out everywhere else.</p>
			<a class="action" href={resolve('/login')}>Sign in</a>
		</div>
	{:else if !data.usable}
		<p class="intro">
			This link has expired or was already used. Reset links work once, for 30 minutes.
		</p>
		<p class="back"><a href={resolve('/login/forgot')}>Send a new link</a></p>
	{:else}
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
				label="New password (at least {MIN_PASSWORD_LENGTH} characters)"
				name="password"
				type="password"
				autocomplete="new-password"
				autocapitalize="off"
				required={true}
				error={undefined}
				bind:value={password}
			/>
			<Button variant="primary" size="large" type="submit" onclick={undefined}>
				Save new password
			</Button>
		</form>
	{/if}
</PublicPage>

<style>
	h1 {
		margin-bottom: var(--space-6);
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		text-align: center;
	}

	.intro {
		color: var(--muted);
		font-size: var(--text-sm);
		text-align: center;
	}

	.form {
		display: grid;
		gap: var(--space-4);
	}

	.done {
		display: grid;
		justify-items: center;
		gap: var(--space-3);
		color: var(--success);
		text-align: center;
	}

	.done p {
		color: var(--text);
		font-size: var(--text-sm);
	}

	.action {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-height: 48px;
		padding: 0 var(--space-6);
		border-radius: var(--radius-pill);
		background: var(--brand);
		color: var(--brand-contrast);
		font-weight: var(--weight-semibold);
		text-decoration: none;
	}

	.problem {
		padding: var(--space-3);
		border-radius: var(--radius-control);
		background: var(--danger-bg);
		color: var(--danger);
		font-size: var(--text-sm);
	}

	.back {
		margin-top: var(--space-4);
		font-size: var(--text-sm);
		text-align: center;
	}

	.back a {
		color: var(--brand);
	}
</style>
