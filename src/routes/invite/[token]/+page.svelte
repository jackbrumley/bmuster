<script lang="ts">
	import { enhance } from '$app/forms';
	import PublicPage from '#lib/shell/public-page.svelte';
	import Button from '#lib/ui/button.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { MIN_PASSWORD_LENGTH } from '#lib/schemas/auth/sign-in.ts';
	import type { PageProps } from './$types';

	/** Accept an invitation: choose a password and sign in (SPEC-EMAIL E5). */
	let { data, form }: PageProps = $props();

	let password = $state('');
</script>

<svelte:head>
	<title>Accept your invitation · BMuster</title>
</svelte:head>

<PublicPage>
	<h1>Welcome to BMuster</h1>
	{#if data.invitation.kind === 'unusable'}
		<p class="intro">
			This invitation has expired or was already used. Invitations work once, for 7 days. Ask the
			admin who invited you for a new one.
		</p>
	{:else}
		<p class="intro">
			Hello {data.invitation.name}. Choose a password for <strong>{data.invitation.email}</strong>
			and you are in.
		</p>
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
				label="Password (at least {MIN_PASSWORD_LENGTH} characters)"
				name="password"
				type="password"
				autocomplete="new-password"
				autocapitalize="off"
				required={true}
				error={undefined}
				bind:value={password}
			/>
			<Button variant="primary" size="large" type="submit" onclick={undefined}>
				Set password and sign in
			</Button>
		</form>
	{/if}
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
		overflow-wrap: anywhere;
	}

	.intro strong {
		color: var(--text);
	}

	.form {
		display: grid;
		gap: var(--space-4);
	}

	.problem {
		padding: var(--space-3);
		border-radius: var(--radius-control);
		background: var(--danger-bg);
		color: var(--danger);
		font-size: var(--text-sm);
	}
</style>
