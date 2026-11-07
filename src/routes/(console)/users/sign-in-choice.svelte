<script lang="ts">
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { MIN_PASSWORD_LENGTH } from '#lib/schemas/auth/sign-in.ts';

	/**
	 * How someone new will sign in (SPEC-EMAIL E5): an invitation to choose
	 * their own password, a password the admin sets now, or a sign-in
	 * provider only. `emailReady` says whether the invitation is emailed or
	 * handed to the admin as a link.
	 */
	type Choice = 'invite' | 'password' | 'provider';

	let {
		choice = $bindable(),
		password = $bindable(),
		emailReady
	}: { choice: Choice; password: string; emailReady: boolean } = $props();

	const options: { value: Choice; label: string }[] = [
		{ value: 'invite', label: 'Invite' },
		{ value: 'password', label: 'Set a password' },
		{ value: 'provider', label: 'Provider only' }
	];

	const hint = $derived.by(() => {
		switch (choice) {
			case 'invite':
				return emailReady
					? 'They get an email with a link to choose their own password. It works once, for 7 days.'
					: 'Email is not set up, so you get a link to pass on. They choose their own password with it, within 7 days.';
			case 'password':
				return 'Tell them the password yourself. They can sign in straight away.';
			case 'provider':
				return emailReady
					? 'They sign in through a provider with this email. They get an email saying how.'
					: 'They sign in through a provider with this email.';
		}
	});
</script>

<SegmentedControl label="How they sign in" {options} bind:value={choice} />
{#if choice === 'password'}
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
{/if}
<p class="hint">{hint}</p>

<style>
	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}
</style>
