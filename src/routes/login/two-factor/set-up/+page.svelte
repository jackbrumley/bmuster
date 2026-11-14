<script lang="ts">
	import { applyAction, enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import PublicPage from '#lib/shell/public-page.svelte';
	import Button from '#lib/ui/button.svelte';
	import Checkbox from '#lib/ui/checkbox.svelte';
	import RecoveryCodes from '#lib/ui/recovery-codes.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import TwoFactorKey from '#lib/ui/two-factor-key.svelte';
	import type { PageProps } from './$types';

	/**
	 * Two-factor set-up at sign-in (SPEC-TWO-FACTOR 2.5): required by the server, so nothing
	 * else opens until it is done. After the first right code the recovery codes show once.
	 */
	let { data, form }: PageProps = $props();

	let code = $state('');
	let saved = $state(false);

	const done = $derived(
		form?.recoveryCodes !== undefined ? { codes: form.recoveryCodes, email: form.email } : undefined
	);
</script>

<svelte:head>
	<title>Set up two-factor sign-in · BMuster</title>
</svelte:head>

<PublicPage width="compact">
	{#if done !== undefined}
		<h1>Two-factor sign-in is on</h1>
		<RecoveryCodes codes={done.codes} email={done.email} origin={data.origin} />
		<div class="saved">
			<Checkbox label="I have saved my recovery codes" error={undefined} bind:checked={saved} />
		</div>
		{#if saved}
			<!-- The code step's page sends a signed-in person on to where they were going. -->
			<a
				class="continue"
				href="{resolve('/login/two-factor')}?{new URLSearchParams({
					returnTo: data.returnTo
				}).toString()}"
				data-sveltekit-reload>Continue</a
			>
		{/if}
	{:else if data.step.kind === 'key'}
		<h1>Set up two-factor sign-in</h1>
		<p class="intro">
			This server asks for a code from an authenticator app after your password. Set it up now to
			finish signing in.
		</p>
		<TwoFactorKey twoFactorKey={data.step.twoFactorKey} />
		<form
			class="form"
			method="POST"
			use:enhance={() =>
				async ({ result, update }) => {
					code = '';
					if (result.type === 'success') {
						await applyAction(result);
						return;
					}
					await update({ reset: false });
				}}
		>
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
			<Button variant="primary" size="large" type="submit" onclick={undefined}>Turn on</Button>
		</form>
	{:else}
		<h1>Your sign-in timed out</h1>
		<p class="intro">For your safety this step lasts 5 minutes. Sign in again to carry on.</p>
		<a class="continue" href={resolve('/login')}>Sign in again</a>
	{/if}
</PublicPage>

<style>
	h1 {
		margin-bottom: var(--space-4);
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		text-align: center;
	}

	.intro {
		margin-bottom: var(--space-4);
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	.form {
		display: grid;
		gap: var(--space-4);
		margin-top: var(--space-6);
	}

	.saved {
		margin-top: var(--space-4);
	}

	.continue {
		display: flex;
		align-items: center;
		justify-content: center;
		min-height: 48px;
		margin-top: var(--space-4);
		border-radius: var(--radius-pill);
		background: var(--brand);
		color: var(--brand-contrast);
		font-weight: var(--weight-semibold);
		text-decoration: none;
	}

	.continue:hover {
		background: var(--brand-hover);
	}
</style>
