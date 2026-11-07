<script lang="ts">
	import {
		IconAdjustments,
		IconArrowsExchange,
		IconCertificate,
		IconDeviceDesktopMinus,
		IconDeviceDesktopPlus,
		IconDevices,
		IconEdit,
		IconNoteOff,
		IconRefresh,
		IconKey,
		IconLock,
		IconLogin2,
		IconLogout,
		IconRocket,
		IconShieldLock,
		IconShieldX,
		IconUser,
		IconUsersGroup
	} from '@tabler/icons-svelte-runes';
	import { activityLabel, type AuditKind } from '#lib/domain/activity/activity.ts';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { formatRelative } from '#lib/utils/format.ts';
	import type { PageProps } from './$types';

	/**
	 * The audit log (SPEC-SIGN-IN S13), newest first. Members see only entries
	 * about machines they can see (SPEC-ACCESS A6).
	 */
	let { data }: PageProps = $props();

	function iconFor(kind: AuditKind): typeof IconUser {
		switch (kind) {
			case 'setup':
				return IconRocket;
			case 'sign-in':
				return IconLogin2;
			case 'sign-in-failed':
				return IconShieldX;
			case 'sign-out':
				return IconLogout;
			case 'user-added':
			case 'user-details-changed':
			case 'user-role-changed':
			case 'user-disabled':
			case 'user-enabled':
				return IconUser;
			case 'user-password-set':
				return IconKey;
			case 'provider-added':
			case 'provider-changed':
			case 'provider-deleted':
				return IconShieldLock;
			case 'setting-changed':
				return IconAdjustments;
			case 'local-certificate-renewed':
				return IconCertificate;
			case 'machine-enrolled':
				return IconDeviceDesktopPlus;
			case 'machine-removed':
				return IconDeviceDesktopMinus;
			case 'machine-renamed':
			case 'machine-description-changed':
				return IconEdit;
			case 'machine-note-deleted':
				return IconNoteOff;
			case 'machine-reinstalled':
				return IconRefresh;
			case 'machine-moved':
				return IconArrowsExchange;
			case 'machine-uninstalled':
				return IconDeviceDesktopMinus;
			case 'local-code-viewed':
				return IconKey;
			case 'user-group-added':
			case 'user-group-changed':
			case 'user-group-deleted':
			case 'user-group-member-added':
			case 'user-group-member-removed':
				return IconUsersGroup;
			case 'machine-group-added':
			case 'machine-group-changed':
			case 'machine-group-deleted':
			case 'machine-group-member-added':
			case 'machine-group-member-removed':
				return IconDevices;
			case 'access-rule-added':
			case 'access-rule-changed':
			case 'access-rule-deleted':
				return IconLock;
		}
	}
</script>

<PageHeader
	title="Activity"
	summary={data.user.role === 'admin'
		? 'Sign-ins, machines joining and leaving, and changes to people, groups, access rules, providers and settings.'
		: 'What has happened on the machines you can see.'}
	actions={undefined}
/>

{#if data.entries.length === 0}
	<p class="empty">Nothing yet.</p>
{:else}
	<ul class="list">
		{#each data.entries as entry (entry.id)}
			{@const Icon = iconFor(entry.kind)}
			<li class="entry" class:refused={entry.kind === 'sign-in-failed'}>
				<span class="icon"><Icon size={20} stroke={1.75} /></span>
				<div class="body">
					<p class="what">
						<strong>{entry.actor.kind === 'user' ? entry.actor.name : 'System'}</strong>
						{activityLabel(entry.kind).toLowerCase()} ·
						<span class="target">{entry.target}</span>
					</p>
					{#if entry.detail.length > 0}
						<p class="detail">
							{entry.detail.map((item) => `${item.label}: ${item.value}`).join(' · ')}
						</p>
					{/if}
				</div>
				<time datetime={entry.atIso}>{formatRelative(entry.atIso, data.now)}</time>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.empty {
		padding: var(--space-12) 0;
		color: var(--muted);
		text-align: center;
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

	.refused .icon {
		background: var(--danger-bg);
		color: var(--danger);
	}

	.body {
		flex: 1;
		min-width: 0;
	}

	.what {
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.target {
		color: var(--brand);
		font-weight: var(--weight-medium);
	}

	.detail {
		color: var(--muted);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}

	time {
		flex-shrink: 0;
		color: var(--muted);
		font-size: var(--text-xs);
		white-space: nowrap;
	}
</style>
