<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import PublicPage from '#lib/shell/public-page.svelte';
	import Button from '#lib/ui/button.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import type { PageProps } from './$types';

	/**
	 * The code step (SPEC-TWO-FACTOR 2.4): a code from the authenticator app, or a recovery code.
	 * The switch only changes the label and keyboard; the server accepts either.
	 */
	let { form }: PageProps = $props();

	let useRecovery = $state(false);
	let code = $state('');
</script>

<svelte:head>
	<title>Two-factor sign-in · BMuster</title>
</svelte:head>

<PublicPage width="compact">
	<h1>Two-factor sign-in</h1>
	<p class="intro">
		{useRecovery
			? 'Type one of the recovery codes you saved when you set up two-factor sign-in. Each one works once.'
			: 'Open your authenticator app and type the 6-digit code it shows for BMuster.'}
	</p>
	<form
		class="form"
		method="POST"
		use:enhance={() =>
			async ({ update }) => {
				code = '';
				await update({ reset: false });
			}}
	>
		{#if useRecovery}
			<TextField
				label="Recovery code"
				name="code"
				type="text"
				autocomplete="off"
				autocapitalize="off"
				required={true}
				error={form?.message}
				bind:value={code}
			/>
		{:else}
			<TextField
				label="Code from your authenticator app"
				name="code"
				type="one-time-code"
				autocomplete="one-time-code"
				autocapitalize="off"
				required={true}
				error={form?.message}
				bind:value={code}
			/>
		{/if}
		<Button variant="primary" size="large" type="submit" onclick={undefined}>Sign in</Button>
	</form>
	<div class="links">
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={() => {
				useRecovery = !useRecovery;
				code = '';
			}}
		>
			{useRecovery ? 'Use a code from your app instead' : 'Use a recovery code instead'}
		</Button>
		<a href={resolve('/login')}>Start again</a>
	</div>
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
		color: var(--text-soft);
		font-size: var(--text-sm);
		text-align: center;
	}

	.form {
		display: grid;
		gap: var(--space-4);
	}

	.links {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		margin-top: var(--space-4);
		font-size: var(--text-sm);
	}

	.links a {
		display: inline-flex;
		align-items: center;
		min-height: 40px;
		color: var(--brand);
	}
</style>
