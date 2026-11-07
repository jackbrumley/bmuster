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
	import TabNav from '#lib/ui/tab-nav.svelte';
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
		// Manage is for admins (its page refuses members anyway).
		...(data.user.role === 'admin'
			? [
					{
						href: resolve('/(console)/machines/[id]/manage', params),
						label: 'Manage',
						icon: IconSettings
					}
				]
			: [])
	]);
</script>

<!-- The machine's own page header: every machine tab shares it, so its pages render no PageHeader. -->
<header class="machine-header">
	<a class="back" href={resolve('/(console)')}><IconChevronLeft size={18} /> Machines</a>
	<div class="identity">
		<OsIcon family={data.machine.osFamily} size={36} />
		<div class="names">
			<h1>{data.machine.name}</h1>
			<p>{data.machine.hostname}</p>
		</div>
		<StatusBadge status={data.machine.status} now={data.now} since="shown" />
	</div>
	{#if data.machine.description !== ''}
		<p class="description">{data.machine.description}</p>
	{/if}
</header>

<TabNav label="Machine" {tabs} current={page.url.pathname} />

{@render children()}

<style>
	.machine-header {
		display: grid;
		gap: var(--space-3);
	}

	.back {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		gap: var(--space-1);
		color: var(--muted);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}

	.back:hover {
		color: var(--text);
	}

	.identity {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}

	.names {
		flex: 1;
		min-width: 0;
	}

	/* The same size as PageHeader's title on the other pages. */
	h1 {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.names p {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	/* Plain text from the admins: line breaks kept, long words wrapped (D2). */
	.description {
		color: var(--text-soft);
		font-size: var(--text-sm);
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
</style>
