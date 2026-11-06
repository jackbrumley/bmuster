<script lang="ts">
	import type { Snippet } from 'svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { IconDots } from '@tabler/icons-svelte-runes';
	import { adminNav, isCurrent, mainNav } from './console-nav.ts';
	import SignedInUser from './signed-in-user.svelte';

	/**
	 * The console frame: a sidebar on wide screens, a bottom tab bar on phones.
	 * Every console page renders inside it; it owns the safe-area padding.
	 */
	let { children }: { children: Snippet } = $props();

	const main = mainNav();
	const admin = adminNav();
	const moreHref = resolve('/(console)/more');
	const moreCurrent = $derived(
		page.url.pathname.startsWith(moreHref) ||
			admin.some((item) => isCurrent(page.url.pathname, item.route))
	);
</script>

<div class="frame">
	<aside class="sidebar">
		<a class="brand" href={resolve('/(console)')}>
			<span class="logo">B</span>
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
		<div class="sidebar-foot">
			<SignedInUser name="Jack Brumley" role="Admin" />
		</div>
	</aside>

	<main class="content">
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

	.content {
		max-width: var(--content-max);
		margin: 0 auto;
		padding: var(--space-4) var(--space-4)
			calc(var(--tabbar-height) + var(--safe-bottom) + var(--space-6));
	}

	.tabbar {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: 10;
		display: grid;
		grid-template-columns: repeat(4, 1fr);
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
			width: 100%;
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

	.logo {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border-radius: var(--radius-control);
		background: var(--brand);
		color: var(--brand-contrast);
		font-weight: var(--weight-bold);
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
		margin-top: auto;
		padding-top: var(--space-4);
		border-top: 1px solid var(--border);
	}
</style>
