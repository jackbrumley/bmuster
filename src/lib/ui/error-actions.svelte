<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IconArrowLeft, IconDevices, IconLogin2, IconRefresh } from '@tabler/icons-svelte-runes';
	import Button from './button.svelte';

	/**
	 * Ways out of an error page (SPEC-ERROR-PAGES E1, E2): to the machine list
	 * (or to sign in, coming back here after), back where the person came
	 * from, and for the server's own errors, the same page again. `large`
	 * stacks them full width in the public card; `compact` puts them in a row.
	 */
	let {
		home,
		retry,
		size
	}: {
		home: { kind: 'machines' } | { kind: 'sign-in'; returnTo: string };
		retry: boolean;
		size: 'compact' | 'large';
	} = $props();

	async function goHome(): Promise<void> {
		switch (home.kind) {
			case 'machines':
				await goto(resolve('/(console)'));
				return;
			case 'sign-in':
				await goto(resolve(`/login?returnTo=${encodeURIComponent(home.returnTo)}`));
				return;
		}
	}

	// Opened straight from a link there is nothing to go back to: go home instead.
	async function goBack(): Promise<void> {
		if (history.length > 1) {
			history.back();
			return;
		}
		await goHome();
	}
</script>

<div class="actions {size}">
	<Button variant="primary" {size} type="button" onclick={() => void goHome()}>
		{#if home.kind === 'machines'}
			<IconDevices size={18} /> Go to Machines
		{:else}
			<IconLogin2 size={18} /> Sign in
		{/if}
	</Button>
	<Button variant="secondary" {size} type="button" onclick={() => void goBack()}>
		<IconArrowLeft size={18} /> Go back
	</Button>
	{#if retry}
		<Button
			variant="secondary"
			{size}
			type="button"
			onclick={() => {
				location.reload();
			}}
		>
			<IconRefresh size={18} /> Try again
		</Button>
	{/if}
</div>

<style>
	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	.large {
		flex-direction: column;
	}
</style>
