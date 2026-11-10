<script lang="ts">
	import { IconDeviceDesktop } from '@tabler/icons-svelte-runes';
	import type { SignedInUser } from '#lib/domain/machines/machine.ts';
	import type { DesktopMode } from '#lib/domain/sessions/session.ts';
	import Button from '#lib/ui/button.svelte';
	import Panel from '#lib/ui/panel.svelte';

	/**
	 * Connect and Watch only (SPEC-DESKTOP R1), offered whenever no session
	 * runs. When the person's rules ask the person at the screen first, it
	 * says so instead, since BMuster cannot ask yet.
	 */
	let {
		user,
		canControl,
		asksFirst,
		onstart
	}: {
		user: SignedInUser;
		canControl: boolean;
		asksFirst: boolean;
		onstart: (mode: DesktopMode) => void;
	} = $props();
</script>

<Panel heading={undefined} actions={undefined} tone="normal" padding="normal">
	<div class="start">
		<IconDeviceDesktop size={40} stroke={1.25} />
		<p>
			{user.kind === 'user'
				? `${user.name} sees a notice while you are connected, and can disconnect you.`
				: 'Nobody is signed in. You see the sign-in screen.'}
		</p>
		{#if asksFirst}
			<p class="hint">
				Your access to this machine asks the person at the screen first. BMuster cannot ask yet, so
				ask an admin to make the rule connect without asking.
			</p>
		{:else}
			<div class="actions">
				{#if canControl}
					<Button
						variant="primary"
						size="compact"
						type="button"
						onclick={() => {
							onstart('control');
						}}>Connect</Button
					>
				{/if}
				<Button
					variant={canControl ? 'secondary' : 'primary'}
					size="compact"
					type="button"
					onclick={() => {
						onstart('watch');
					}}>Watch only</Button
				>
			</div>
		{/if}
	</div>
</Panel>

<style>
	.start {
		display: grid;
		justify-items: center;
		gap: var(--space-2);
		padding: var(--space-4) 0;
		color: var(--text-soft);
		text-align: center;
		font-size: var(--text-sm);
	}

	.start p {
		margin: 0;
		max-width: 46ch;
	}

	.hint {
		color: var(--muted);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin-top: var(--space-2);
	}
</style>
