<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconLogout } from '@tabler/icons-svelte-runes';
	import { roleLabel, type ConsoleUser } from '#lib/domain/users/user.ts';
	import ThemeSwitch from '#lib/ui/theme-switch.svelte';
	import { VERSION } from './console-nav.ts';

	/**
	 * Who is signed in, a sign-out button and the version. Bottom of the
	 * sidebar and the "More" page. Sign-out is a form POST to /logout, so it
	 * works without JavaScript and cannot be triggered by a link.
	 */
	let { user }: { user: ConsoleUser } = $props();
</script>

<div class="signed-in">
	<div class="who">
		<span class="avatar">{user.name.slice(0, 1)}</span>
		<div class="names">
			<p class="name"><a href={resolve('/(console)/account')}>{user.name}</a></p>
			<p class="role">{roleLabel(user.role)} · {user.email}</p>
		</div>
		<form method="POST" action={resolve('/logout')}>
			<button
				data-raw-button="icon"
				type="submit"
				class="sign-out"
				aria-label="Sign out"
				title="Sign out"
			>
				<IconLogout size={20} />
			</button>
		</form>
	</div>
	<ThemeSwitch />
	<p class="version">BMuster v{VERSION}</p>
</div>

<style>
	.signed-in {
		display: grid;
		/* minmax(0, …): a long email ellipsises instead of widening the sidebar. */
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
	}

	.who {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	.avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		flex-shrink: 0;
		border-radius: var(--radius-round);
		background: var(--brand-tint);
		color: var(--brand);
		font-weight: var(--weight-bold);
	}

	.names {
		flex: 1;
		min-width: 0;
	}

	.name,
	.role {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.name {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.name a {
		color: inherit;
		text-decoration: none;
	}

	.name a:hover {
		color: var(--brand);
	}

	.role {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.sign-out {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		border: none;
		border-radius: var(--radius-pill);
		background: transparent;
		color: var(--muted);
		cursor: pointer;
	}

	.sign-out:hover {
		background: var(--surface-muted);
		color: var(--danger);
	}

	.version {
		color: var(--muted);
		font-size: var(--text-xs);
		text-align: center;
	}
</style>
