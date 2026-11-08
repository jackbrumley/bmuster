<script lang="ts">
	import { resolve } from '$app/paths';
	import {
		IconAdjustments,
		IconAlertTriangle,
		IconArrowsExchange,
		IconBell,
		IconCertificate,
		IconCloudDownload,
		IconDeviceDesktopMinus,
		IconDeviceDesktopPlus,
		IconDevices,
		IconDownload,
		IconEdit,
		IconFolderPlus,
		IconNoteOff,
		IconRefresh,
		IconKey,
		IconLock,
		IconMail,
		IconMailOff,
		IconLogin2,
		IconLogout,
		IconPlugConnected,
		IconTrash,
		IconPhone,
		IconPhoneOff,
		IconPin,
		IconRocket,
		IconShieldLock,
		IconShieldX,
		IconPlugConnectedX,
		IconMessage,
		IconTerminal2,
		IconUpload,
		IconUser,
		IconUsersGroup,
		IconWifi,
		IconWifiOff
	} from '@tabler/icons-svelte-runes';
	import {
		activityLabel,
		type ActivityEntry,
		type AuditKind
	} from '#lib/domain/activity/activity.ts';
	import { activitySentence } from '#lib/domain/activity/local-page-activity.ts';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import ExportButton from '#lib/ui/export-button.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { formatRelative } from '#lib/utils/format.ts';
	import type { PageProps } from './$types';

	/**
	 * The audit log (SPEC-SIGN-IN S13), newest first. Members see only entries
	 * about machines they can see (SPEC-ACCESS A6).
	 */
	let { data }: PageProps = $props();

	/** Everything the person may read, with local times in this browser's time zone (X7). */
	const exportHref = $derived(
		`${resolve('/api/exports/activity')}?${new URLSearchParams({
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
		}).toString()}`
	);

	/** A local page event that reached the server this much later happened while it was away. */
	const REPORTED_LATE_MS = 2 * 60_000;

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
			case 'server-update-checked':
			case 'server-update-requested':
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
			case 'local-signed-in':
				return IconLogin2;
			case 'local-signed-out':
			case 'local-session-expired':
				return IconLogout;
			case 'local-wrong-code':
			case 'local-locked-out':
				return IconShieldX;
			case 'local-restarted':
				return IconRefresh;
			case 'local-connection-tested':
				return IconPlugConnected;
			case 'local-move-started':
			case 'local-move-finished':
			case 'local-move-failed':
			case 'local-leaving':
				return IconArrowsExchange;
			case 'local-uninstalled':
				return IconTrash;
			case 'local-events-dropped':
				return IconAlertTriangle;
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
			case 'session-opened':
			case 'session-ended':
				return IconTerminal2;
			case 'session-disconnected-at-machine':
				return IconPlugConnectedX;
			case 'machine-message-sent':
				return IconMessage;
			case 'email-sent':
			case 'invitation-created':
			case 'invitation-accepted':
				return IconMail;
			case 'email-failed':
				return IconMailOff;
			case 'password-reset-requested':
			case 'password-reset':
				return IconKey;
			case 'notification-rule-added':
			case 'notification-rule-changed':
			case 'notification-rule-deleted':
				return IconBell;
			case 'agent-updated':
			case 'agent-update-requested':
			case 'agent-rollout-resumed':
				return IconCloudDownload;
			case 'agent-update-rolled-back':
			case 'agent-update-refused':
			case 'agent-rollout-paused':
				return IconAlertTriangle;
			case 'agent-pinned':
			case 'agent-unpinned':
				return IconPin;
			case 'list-exported':
				return IconDownload;
			case 'file-downloaded':
				return IconDownload;
			case 'file-uploaded':
				return IconUpload;
			case 'files-deleted':
				return IconTrash;
			case 'file-renamed':
				return IconEdit;
			case 'folder-created':
				return IconFolderPlus;
			case 'machine-offline':
				return IconWifiOff;
			case 'machine-online':
				return IconWifi;
			case 'support-code-started':
			case 'support-code-entered':
				return IconPhone;
			case 'support-code-cancelled':
				return IconPhoneOff;
			case 'support-code-scam-stop':
				return IconShieldX;
		}
	}
</script>

<PageHeader
	title="Activity"
	summary={data.user.role === 'admin'
		? 'Sign-ins, machines joining and leaving, and changes to people, groups, access rules, providers and settings.'
		: 'What has happened on the machines you can see.'}
>
	{#snippet actions()}
		<ExportButton href={exportHref} />
	{/snippet}
</PageHeader>

{#snippet entryRow(entry: ActivityEntry)}
	{@const Icon = iconFor(entry.kind)}
	{@const sentence = activitySentence(entry)}
	<ListRow action={{ kind: 'static' }} align="start" dimmed={false}>
		<span
			class="icon"
			class:refused={entry.kind === 'sign-in-failed'}
			class:warning={sentence.kind !== 'standard' && sentence.warning}
		>
			<Icon size={20} stroke={1.75} />
		</span>
		<div class="body">
			{#if sentence.kind === 'local'}
				<p class="what">{sentence.text}</p>
				{#if Date.parse(sentence.sentIso) - Date.parse(entry.atIso) > REPORTED_LATE_MS}
					<p class="detail">
						Reported by the agent {formatRelative(sentence.sentIso, data.now)}, after it was offline
					</p>
				{/if}
			{:else if sentence.kind === 'presence'}
				<p class="what">{sentence.text}</p>
			{:else}
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
			{/if}
		</div>
		<time datetime={entry.atIso}>{formatRelative(entry.atIso, data.now)}</time>
	</ListRow>
{/snippet}

<ListCard
	heading={undefined}
	actions={undefined}
	label="Activity, newest first"
	items={data.entries}
	key={(entry: ActivityEntry) => entry.id}
	row={entryRow}
	empty="Nothing yet."
/>

<style>
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

	.icon.refused {
		background: var(--danger-bg);
		color: var(--danger);
	}

	.icon.warning {
		background: var(--warning-bg);
		color: var(--warning);
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
