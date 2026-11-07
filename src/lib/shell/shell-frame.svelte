<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { IconCertificate, IconDots } from '@tabler/icons-svelte-runes';
	import type { ConsoleUser } from '#lib/domain/users/user.ts';
	import ConfirmDialog from '#lib/ui/confirm-dialog.svelte';
	import Logo from '#lib/ui/logo.svelte';
	import ToastHost from '#lib/ui/toast-host.svelte';
	import { adminNav, isCurrent, mainNav } from './console-nav.ts';
	import SignedInUser from './signed-in-user.svelte';

	/**
	 * The console frame: a sidebar on wide screens, a bottom tab bar on phones.
	 * Every console page renders inside it; it owns the safe-area padding, the
	 * shared confirmation dialog and the toasts. In local network mode every
	 * page carries a banner (SPEC-INSTALL-OPTIONS L3).
	 */
	let {
		user,
		localNetworkMode,
		children
	}: { user: ConsoleUser; localNetworkMode: boolean; children: Snippet } = $props();

	const main = $derived(mainNav(user.role));
	const admin = $derived(adminNav(user.role));
	const moreHref = resolve('/(console)/more');
	const moreCurrent = $derived(
		page.url.pathname.startsWith(moreHref) ||
			admin.some((item) => isCurrent(page.url.pathname, item.route))
	);
</script>

<div class="frame">
	<aside class="sidebar">
		<a class="brand" href={resolve('/(console)')}>
			<Logo size={32} />
			<span class="wordmark">BMuster</span>
		</a>
		<nav aria-label="Main">
			{#each main as item (item.route)}
				<a
					class="nav-link"
					href={resolve(item.route)}
					aria-current={isCurrent(page.url.pathname, item.route) ? 'page' : undefined}
				>
					<item.icon size={20} stroke={1.75} />
					{item.label}
				</a>
			{/each}
		</nav>
		{#if admin.length > 0}
			<nav aria-label="Administration">
				<p class="nav-heading">Administration</p>
				{#each admin as item (item.route)}
					<a
						class="nav-link"
						href={resolve(item.route)}
						aria-current={isCurrent(page.url.pathname, item.route) ? 'page' : undefined}
					>
						<item.icon size={20} stroke={1.75} />
						{item.label}
					</a>
				{/each}
			</nav>
		{/if}
		<div class="sidebar-foot">
			<SignedInUser {user} />
		</div>
	</aside>

	<main class="content">
		{#if localNetworkMode}
			<p class="mode-banner" role="status">
				<IconCertificate size={16} stroke={1.75} />
				Local network mode: self-signed certificate
			</p>
		{/if}
		{@render children()}
	</main>

	<nav class="tabbar" aria-label="Main">
		{#each main as item (item.route)}
			<a
				class="tab"
				href={resolve(item.route)}
				aria-current={isCurrent(page.url.pathname, item.route) ? 'page' : undefined}
			>
				<item.icon size={22} stroke={1.75} />
				<span>{item.label}</span>
			</a>
		{/each}
		<a class="tab" href={moreHref} aria-current={moreCurrent ? 'page' : undefined}>
			<IconDots size={22} stroke={1.75} />
			<span>More</span>
		</a>
	</nav>

	<ConfirmDialog />
	<ToastHost />
</div>

<style>
	.frame {
		min-height: 100dvh;
		padding-top: var(--safe-top);
		padding-left: var(--safe-left);
		padding-right: var(--safe-right);
	}

	.sidebar {
		display: none;
	}

	/*
	 * Every console page is the same width and lays its blocks (header,
	 * panels, lists) out with the same gap, so a page adds no outer margins
	 * of its own.
	 */
	.content {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: start;
		gap: var(--gap-section);
		width: 100%;
		max-width: var(--content-max);
		margin: 0 auto;
		padding: var(--space-4) var(--space-4)
			calc(var(--tabbar-height) + var(--safe-bottom) + var(--space-6));
	}

	.mode-banner {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-pill);
		background: var(--warning-bg);
		color: var(--warning);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.tabbar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 10;
		display: grid;
		grid-auto-columns: 1fr;
		grid-auto-flow: column;
		height: calc(var(--tabbar-height) + var(--safe-bottom));
		padding-bottom: var(--safe-bottom);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-bar);
	}

	.tab {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-1);
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
	}

	.tab[aria-current='page'] {
		color: var(--brand);
	}

	@media (min-width: 900px) {
		.frame {
			display: grid;
			grid-template-columns: var(--sidebar-width) 1fr;
		}

		.sidebar {
			position: sticky;
			top: 0;
			display: flex;
			flex-direction: column;
			gap: var(--space-6);
			height: 100dvh;
			padding: var(--space-6) var(--space-4) var(--space-4);
			border-right: 1px solid var(--border);
			background: var(--surface-elevated);
		}

		.content {
			padding: var(--space-8);
		}

		.tabbar {
			display: none;
		}
	}

	.brand {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: 0 var(--space-2);
	}

	.wordmark {
		font-size: var(--text-lg);
		font-weight: var(--weight-bold);
	}

	nav {
		display: grid;
		gap: var(--space-1);
	}

	.nav-heading {
		padding: 0 var(--space-3) var(--space-1);
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
	}

	.nav-link {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-pill);
		color: var(--text-soft);
		font-weight: var(--weight-medium);
	}

	.nav-link:hover {
		background: var(--surface-muted);
	}

	.nav-link[aria-current='page'] {
		background: var(--brand-tint);
		color: var(--brand);
	}

	.sidebar-foot {
		min-width: 0;
		margin-top: auto;
		padding-top: var(--space-4);
		border-top: 1px solid var(--border);
	}
</style>
