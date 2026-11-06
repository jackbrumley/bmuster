<script lang="ts">
	import { resolve } from '$app/paths';
	import { IconLogout } from '@tabler/icons-svelte-runes';
	import ThemeSwitch from '#lib/ui/theme-switch.svelte';
	import { VERSION } from './console-nav.ts';

	/** Who is signed in, a sign-out button and the version. Bottom of the sidebar and the "More" page. */
	let { name, role }: { name: string; role: string } = $props();
</script>

<div class="signed-in">
	<div class="who">
		<span class="avatar">{name.slice(0, 1)}</span>
		<div class="names">
			<p class="name">{name}</p>
			<p class="role">{role}</p>
		</div>
		<a class="sign-out" href={resolve('/login')} aria-label="Sign out" title="Sign out">
			<IconLogout size={20} />
		</a>
	</div>
	<ThemeSwitch />
	<p class="version">BMuster v{VERSION}</p>
</div>

<style>
	.signed-in {
		display: grid;
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

	.name {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.role {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.sign-out {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		border-radius: var(--radius-pill);
		color: var(--muted);
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
