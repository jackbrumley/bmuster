<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IconBell, IconBellOff, IconPlus } from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import {
		notificationRuleRequestSchema,
		ruleChangedReplySchema,
		testNotificationReplySchema
	} from '#lib/schemas/notifications/notifications.ts';
	import {
		NOTIFICATION_CATALOGUE,
		recipientsLabel,
		scopeLabel,
		type NotificationRuleView
	} from '#lib/domain/notifications/notifications.ts';
	import SettingsTabs from '../settings-tabs.svelte';
	import RuleForm from './rule-form.svelte';
	import { draftOf, newDraft, requestOf, type RuleDraft } from './rule-draft.ts';
	import type { PageProps } from './$types';

	/**
	 * Notification rules (SPEC-EMAIL E6): who hears about which event. None
	 * exist until an admin adds one.
	 */
	let { data }: PageProps = $props();

	let panel = $state<{ kind: 'closed' } | { kind: 'add' } | { kind: 'edit'; id: string }>({
		kind: 'closed'
	});
	let draft = $state<RuleDraft>(newDraft());
	let problem = $state<string | undefined>(undefined);
	let busy = $state(false);

	const editingId = $derived(panel.kind === 'edit' ? panel.id : undefined);
	const editing = $derived(data.rules.find((rule) => rule.id === editingId));

	function openAdd(): void {
		draft = newDraft();
		problem = undefined;
		panel = { kind: 'add' };
	}

	function openEdit(rule: NotificationRuleView): void {
		draft = draftOf(rule);
		problem = undefined;
		panel = { kind: 'edit', id: rule.id };
	}

	function close(): void {
		panel = { kind: 'closed' };
	}

	async function save(): Promise<void> {
		const parsed = notificationRuleRequestSchema.safeParse(requestOf(draft));
		if (!parsed.success) {
			problem = parsed.error.issues[0]?.message;
			return;
		}
		busy = true;
		const result = await apiRequest({
			method: panel.kind === 'edit' ? 'PATCH' : 'POST',
			url:
				panel.kind === 'edit' ? `/api/notification-rules/${panel.id}` : '/api/notification-rules',
			body: parsed.data,
			reply: ruleChangedReplySchema
		});
		busy = false;
		if (!result.ok) {
			problem = result.message;
			return;
		}
		showToast('Notification rule saved.', 'success');
		close();
		await refreshAll();
	}

	async function remove(rule: NotificationRuleView): Promise<void> {
		const yes = await confirmAction({
			title: 'Delete this rule?',
			message: `Nobody will be emailed about “${NOTIFICATION_CATALOGUE[rule.eventKind].label}” through it any more.`,
			confirmLabel: 'Delete'
		});
		if (!yes) {
			return;
		}
		const result = await apiRequest({
			method: 'DELETE',
			url: `/api/notification-rules/${rule.id}`,
			body: undefined,
			reply: ruleChangedReplySchema
		});
		showToast(result.ok ? 'Rule deleted.' : result.message, result.ok ? 'success' : 'error');
		close();
		await refreshAll();
	}

	async function sendTest(rule: NotificationRuleView): Promise<void> {
		const result = await apiRequest({
			method: 'POST',
			url: `/api/notification-rules/${rule.id}/test`,
			body: {},
			reply: testNotificationReplySchema
		});
		showToast(
			result.ok
				? `Test notification queued for ${result.data.recipients.join(', ')}.`
				: result.message,
			result.ok ? 'success' : 'error'
		);
	}
</script>

<PageHeader title="Settings" summary="How this server behaves. Every change is in Activity.">
	{#snippet actions()}
		<Button variant="primary" size="compact" type="button" onclick={openAdd}>
			<IconPlus size={18} /> Add rule
		</Button>
	{/snippet}
</PageHeader>

<SettingsTabs />

{#if !data.emailReady}
	<Panel heading={undefined} actions={undefined} tone="normal" padding="normal">
		<p class="note">
			Email is not set up, so rules send nothing yet.
			<a href={resolve('/(console)/settings/email')}>Set up email</a>.
		</p>
	</Panel>
{/if}

{#snippet ruleRow(rule: NotificationRuleView)}
	<ListRow
		action={{
			kind: 'button',
			onclick: () => {
				openEdit(rule);
			}
		}}
		align="start"
		dimmed={!rule.enabled}
	>
		<span class="icon">
			{#if rule.enabled}<IconBell size={20} />{:else}<IconBellOff size={20} />{/if}
		</span>
		<span class="body">
			<span class="event">{NOTIFICATION_CATALOGUE[rule.eventKind].label}</span>
			<span class="meta">{scopeLabel(rule.scope)}</span>
			<span class="meta">To {recipientsLabel(rule.recipients)}</span>
		</span>
		<span class="state">{rule.enabled ? 'On' : 'Off'}</span>
	</ListRow>
{/snippet}

<ListCard
	heading="Notification rules"
	actions={undefined}
	label="Notification rules"
	items={data.rules}
	key={(rule: NotificationRuleView) => rule.id}
	row={ruleRow}
	empty="No rules, so nobody is notified of anything. Add one to start."
/>

<Modal
	open={panel.kind !== 'closed'}
	title={panel.kind === 'add' ? 'Add a notification rule' : 'Edit notification rule'}
	onclose={close}
>
	<RuleForm
		bind:draft
		userGroups={data.userGroups}
		machineGroups={data.machineGroups}
		machines={data.machines}
		error={problem}
	/>
	{#snippet footer()}
		{#if editing !== undefined}
			{@const rule = editing}
			<Button variant="danger" size="compact" type="button" onclick={() => void remove(rule)}>
				Delete
			</Button>
			<Button variant="secondary" size="compact" type="button" onclick={() => void sendTest(rule)}>
				Send test
			</Button>
		{:else}
			<Button variant="secondary" size="compact" type="button" onclick={close}>Cancel</Button>
		{/if}
		<Button variant="primary" size="compact" type="button" onclick={() => void save()}>
			{busy ? 'Saving…' : 'Save'}
		</Button>
	{/snippet}
</Modal>

<style>
	.note {
		font-size: var(--text-sm);
	}

	.note a {
		color: var(--brand);
	}

	.icon {
		display: inline-flex;
		flex-shrink: 0;
		padding-top: var(--space-0-5);
		color: var(--brand);
	}

	.body {
		display: grid;
		flex: 1;
		gap: var(--space-0-5);
		min-width: 0;
	}

	.event {
		font-weight: var(--weight-semibold);
	}

	.meta {
		color: var(--muted);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}

	.state {
		flex-shrink: 0;
		padding: 0 var(--space-2);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--text-soft);
		font-size: var(--text-xs);
	}
</style>
