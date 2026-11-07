<script lang="ts">
	import {
		IconDeviceDesktop,
		IconFileUpload,
		IconLink,
		IconPlugConnectedX,
		IconPlus,
		IconTerminal2
	} from '@tabler/icons-svelte-runes';
	import { activityLabel, type ActivityKind } from '#lib/domain/activity/activity.ts';
	import { formatRelative } from '#lib/utils/format.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	function iconFor(kind: ActivityKind): typeof IconTerminal2 {
		switch (kind) {
			case 'terminal-opened':
				return IconTerminal2;
			case 'desktop-opened':
				return IconDeviceDesktop;
			case 'file-sent':
				return IconFileUpload;
			case 'machine-enrolled':
				return IconPlus;
			case 'machine-offline':
				return IconPlugConnectedX;
			case 'share-link-created':
				return IconLink;
		}
	}
</script>

<header class="page-head">
	<h1>Activity</h1>
	<p class="sub">Who connected to what, and when.</p>
</header>

<ul class="list">
	{#each data.entries as entry (entry.id)}
		{@const Icon = iconFor(entry.kind)}
		<li class="entry">
			<span class="icon"><Icon size={20} stroke={1.75} /></span>
			<div class="body">
				<p class="what">
					<strong>{entry.actor}</strong>
					{activityLabel(entry.kind).toLowerCase()} ·
					<span class="machine">{entry.machineName}</span>
				</p>
				<p class="detail">{entry.detail}</p>
			</div>
			<time datetime={entry.atIso}>{formatRelative(entry.atIso, data.now)}</time>
		</li>
	{/each}
</ul>

<style>
	.page-head {
		display: grid;
		gap: var(--space-1);
		margin-bottom: var(--space-4);
	}

	h1 {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
	}

	.sub {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.list {
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		overflow: hidden;
	}

	.entry {
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--space-4);
	}

	.entry + .entry {
		border-top: 1px solid var(--border);
	}

	.icon {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 36px;
		height: 36px;
		flex-shrink: 0;
		border-radius: var(--radius-round);
		background: var(--surface-muted);
		color: var(--text-soft);
	}

	.body {
		flex: 1;
		min-width: 0;
	}

	.what {
		font-size: var(--text-sm);
	}

	.what .machine {
		color: var(--brand);
		font-weight: var(--weight-medium);
	}

	.detail {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	time {
		flex-shrink: 0;
		color: var(--muted);
		font-size: var(--text-xs);
		white-space: nowrap;
	}
</style>
