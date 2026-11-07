<script lang="ts">
	import { enhance } from '$app/forms';
	import PublicPage from '#lib/shell/public-page.svelte';
	import Button from '#lib/ui/button.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { MIN_PASSWORD_LENGTH } from '#lib/schemas/auth/sign-in.ts';
	import type { PageProps } from './$types';

	/** First run: make the first admin, with the setup code from the server's log (SPEC-SIGN-IN S1, S17). */
	let { form }: PageProps = $props();

	let setupCode = $state('');
	let name = $state('');
	let email = $state('');
	let password = $state('');

	function errorFor(field: 'setupCode' | 'name' | 'email' | 'password'): string | undefined {
		return form?.field === field ? form.message : undefined;
	}
</script>

<svelte:head>
	<title>Set up · BMuster</title>
</svelte:head>

<PublicPage>
	<h1>Set up BMuster</h1>
	<p class="intro">
		Enter the setup code BMuster printed in its log when it started, then make the first admin
		account. You can add other people and sign-in providers once you are in.
	</p>

	<form class="form" method="POST" use:enhance>
		<TextField
			label="Setup code"
			name="setupCode"
			type="text"
			autocomplete="off"
			autocapitalize="off"
			required={true}
			error={errorFor('setupCode')}
			bind:value={setupCode}
		/>
		<TextField
			label="Your name"
			name="name"
			type="text"
			autocomplete="name"
			autocapitalize="words"
			required={true}
			error={errorFor('name')}
			bind:value={name}
		/>
		<TextField
			label="Email"
			name="email"
			type="email"
			autocomplete="email"
			autocapitalize="off"
			required={true}
			error={errorFor('email')}
			bind:value={email}
		/>
		<TextField
			label="Password (at least {MIN_PASSWORD_LENGTH} characters)"
			name="password"
			type="password"
			autocomplete="new-password"
			autocapitalize="off"
			required={true}
			error={errorFor('password')}
			bind:value={password}
		/>
		<Button variant="primary" size="large" type="submit" onclick={undefined}>
			Create admin and sign in
		</Button>
	</form>
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
</style>
