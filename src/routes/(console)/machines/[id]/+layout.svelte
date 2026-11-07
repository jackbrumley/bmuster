<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		IconChevronLeft,
		IconDeviceDesktop,
		IconFolder,
		IconInfoCircle,
		IconNotes,
		IconSettings,
		IconTerminal2
	} from '@tabler/icons-svelte-runes';
	import OsIcon from '#lib/ui/os-icon.svelte';
	import StatusBadge from '#lib/ui/status-badge.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	const params = $derived({ id: data.machine.id });

	const tabs = $derived([
		{ href: resolve('/(console)/machines/[id]', params), label: 'Overview', icon: IconInfoCircle },
		{
			href: resolve('/(console)/machines/[id]/terminal', params),
			label: 'Terminal',
			icon: IconTerminal2
		},
		{
			href: resolve('/(console)/machines/[id]/desktop', params),
			label: 'Desktop',
			icon: IconDeviceDesktop
		},
		{ href: resolve('/(console)/machines/[id]/files', params), label: 'Files', icon: IconFolder },
		{ href: resolve('/(console)/machines/[id]/notes', params), label: 'Notes', icon: IconNotes },
		{
			href: resolve('/(console)/machines/[id]/manage', params),
			label: 'Manage',
			icon: IconSettings
		}
	]);
</script>

<a class="back" href={resolve('/(console)')}><IconChevronLeft size={18} /> Machines</a>

<div class="identity">
	<header class="head">
		<OsIcon family={data.machine.osFamily} size={36} />
		<div class="names">
			<h1>{data.machine.name}</h1>
			<p>{data.machine.hostname}</p>
		</div>
		<StatusBadge status={data.machine.status} now={data.now} />
	</header>
	{#if data.machine.description !== ''}
		<p class="description">{data.machine.description}</p>
	{/if}
</div>

<nav class="tabs" aria-label="Machine">
	{#each tabs as tab (tab.href)}
		<a
			class="tab"
			href={tab.href}
			aria-current={page.url.pathname === tab.href ? 'page' : undefined}
		>
			<tab.icon size={18} stroke={1.75} />
			{tab.label}
		</a>
	{/each}
</nav>

{@render children()}

<style>
	.back {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		margin-bottom: var(--space-3);
		color: var(--muted);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}

	.identity {
		display: grid;
		gap: var(--space-2);
		margin-bottom: var(--space-4);
	}

	.head {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	/* Plain text from the admins: line breaks kept, long words wrapped (D2). */
	.description {
		color: var(--text-soft);
		font-size: var(--text-sm);
		white-space: pre-line;
		overflow-wrap: anywhere;
	}

	.names {
		flex: 1;
		min-width: 0;
	}

	h1 {
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.names p {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.tabs {
		display: flex;
		gap: var(--space-1);
		margin-bottom: var(--space-4);
		padding: var(--space-1);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		overflow-x: auto;
		scrollbar-width: none;
	}

	.tab {
		display: inline-flex;
		flex: 1;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-pill);
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		white-space: nowrap;
	}

	.tab[aria-current='page'] {
		background: var(--surface-elevated);
		color: var(--text);
		box-shadow: var(--shadow-card);
	}
</style>
