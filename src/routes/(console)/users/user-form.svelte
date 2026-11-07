<script lang="ts">
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import type { ConsoleRole } from '#lib/domain/users/user.ts';

	/**
	 * The fields of the add and edit forms. `email` is read-only for someone a
	 * provider signs in (the provider keeps it); a password is offered only
	 * where an admin may reset one. A new user's sign-in is chosen in
	 * sign-in-choice.svelte.
	 */
	let {
		name = $bindable(),
		email = $bindable(),
		role = $bindable(),
		password = $bindable(),
		emailEditable,
		passwordMode
	}: {
		name: string;
		email: string;
		role: ConsoleRole;
		password: string;
		emailEditable: { kind: 'yes' } | { kind: 'no'; providerNames: string[] };
		passwordMode:
			| { kind: 'chosen-separately' }
			| { kind: 'optional-reset' }
			| { kind: 'not-here'; reason: string };
	} = $props();

	const roles: { value: ConsoleRole; label: string }[] = [
		{ value: 'member', label: 'Member' },
		{ value: 'admin', label: 'Admin' }
	];
</script>

<TextField
	label="Name"
	name="name"
	type="text"
	autocomplete="off"
	autocapitalize="words"
	required={true}
	error={undefined}
	bind:value={name}
/>
{#if emailEditable.kind === 'yes'}
	<TextField
		label="Email"
		name="email"
		type="email"
		autocomplete="off"
		autocapitalize="off"
		required={true}
		error={undefined}
		bind:value={email}
	/>
{:else}
	<div class="fixed">
		<span class="label">Email</span>
		<p>{email}</p>
		<p class="hint">Kept by {emailEditable.providerNames.join(', ')}; change it there.</p>
	</div>
{/if}
<SegmentedControl label="Role" options={roles} bind:value={role} />
{#if passwordMode.kind === 'not-here'}
	<p class="hint">{passwordMode.reason}</p>
{:else if passwordMode.kind === 'optional-reset'}
	<TextField
		label="New password (leave empty to keep the current one)"
		name="password"
		type="password"
		autocomplete="new-password"
		autocapitalize="off"
		required={false}
		error={undefined}
		bind:value={password}
	/>
{/if}

<style>
	.fixed {
		display: grid;
		gap: var(--space-1);
		font-size: var(--text-sm);
	}

	.label {
		color: var(--text-soft);
		font-weight: var(--weight-medium);
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}
</style>
