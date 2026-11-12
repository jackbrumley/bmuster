<script lang="ts">
	import { onMount } from 'svelte';
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		IconChevronLeft,
		IconDeviceDesktop,
		IconFolder,
		IconChartDonut,
		IconInfoCircle,
		IconNotes,
		IconSettings,
		IconTerminal2
	} from '@tabler/icons-svelte-runes';
	import OsIcon from '#lib/ui/os-icon.svelte';
	import StatusBadge from '#lib/ui/status-badge.svelte';
	import UpdateBadge from '#lib/ui/update-badge.svelte';
	import TabNav from '#lib/ui/tab-nav.svelte';
	import { LiveStatuses } from '#lib/runes/live-statuses.svelte.ts';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();

	// The header's status follows the machine live, on every tab (SPEC-PRESENCE P5).
	const statuses = new LiveStatuses();
	onMount(() => statuses.connect(resolve('/api/machines/events'), refreshAll));
	const status = $derived(statuses.statusOf(data.machine.id, data.machine.status, data.now));
	const now = $derived(Math.max(data.now, statuses.latestAtMs));

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
		{
			href: resolve('/(console)/machines/[id]/storage', params),
			label: 'Storage',
			icon: IconChartDonut
		},
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
		<div class="badges">
			<StatusBadge {status} {now} since="shown" />
			<UpdateBadge state={data.machine.update} />
		</div>
	</div>
	{#if data.machine.description !== ''}
		<p class="description">{data.machine.description}</p>
	{/if}
</header>

<TabNav label="Machine" {tabs} current={page.url.pathname} />

{@render children()}

<style>
	/* minmax(0, 1fr): a long name or badge shortens the name, never widens the page. */
	.machine-header {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
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

	/* Icon, names, badges in a row; on a phone the badges drop under the name. */
	.identity {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		column-gap: var(--space-3);
		row-gap: var(--space-2);
	}

	.names {
		min-width: 0;
	}

	.badges {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-1);
	}

	@media (max-width: 640px) {
		.badges {
			grid-column: 2 / -1;
			justify-content: flex-start;
		}
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
		overflow: hidden;
		color: var(--muted);
		font-size: var(--text-sm);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Plain text from the admins: line breaks kept, long words wrapped (D2). */
	.description {
		color: var(--text-soft);
		font-size: var(--text-sm);
		white-space: pre-line;
		overflow-wrap: anywhere;
	}
</style>
