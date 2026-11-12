<script lang="ts">
	import { resolve } from '$app/paths';
	import { refreshAll } from '$app/navigation';
	import { IconArrowRight, IconPlus } from '@tabler/icons-svelte-runes';
	import {
		consentLabel,
		type AccessRuleView,
		type Consent,
		type Permission
	} from '#lib/domain/access/access.ts';
	import { accessRuleRequestSchema, changedReplySchema } from '#lib/schemas/access/access.ts';
	import Button from '#lib/ui/button.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import ExportButton from '#lib/ui/export-button.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import PermissionChips from '#lib/ui/permission-chips.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import ActiveShareLinks from './active-share-links.svelte';
	import RuleForm from './rule-form.svelte';
	import { describeRule, groupName } from './rule-names.ts';
	import type { PageProps } from './$types';

	/** Access rules (SPEC-ACCESS A4): list → view → edit. */
	let { data }: PageProps = $props();

	type Panel =
		| { kind: 'closed' }
		| { kind: 'view'; id: string }
		| { kind: 'edit'; id: string }
		| { kind: 'add' };

	let panel = $state<Panel>({ kind: 'closed' });
	let userGroupId = $state<string | null>(null);
	let machineGroupId = $state<string | null>(null);
	let permissions = $state<Permission[]>([]);
	let consent = $state<Consent>('unattended');
	let problem = $state<string | undefined>(undefined);
	let busy = $state(false);

	const selectedId = $derived(
		panel.kind === 'view' || panel.kind === 'edit' ? panel.id : undefined
	);
	const selected = $derived(data.rules.find((rule) => rule.id === selectedId));

	function close(): void {
		panel = { kind: 'closed' };
		problem = undefined;
	}

	function openForm(rule: AccessRuleView | undefined): void {
		userGroupId = rule?.userGroupId ?? null;
		machineGroupId = rule?.machineGroupId ?? null;
		permissions = [...(rule?.permissions ?? data.defaults.permissions)];
		consent = rule?.consent ?? data.defaults.consent;
		problem = undefined;
		panel = rule === undefined ? { kind: 'add' } : { kind: 'edit', id: rule.id };
	}

	function describe(rule: AccessRuleView): string {
		return describeRule(rule, data.userGroups, data.machineGroups);
	}

	async function save(): Promise<void> {
		if (userGroupId === null || machineGroupId === null) {
			problem = 'Pick a group of people and a group of machines.';
			return;
		}
		const checked = accessRuleRequestSchema.safeParse({
			userGroupId,
			machineGroupId,
			permissions,
			consent
		});
		if (!checked.success) {
			problem = checked.error.issues[0]?.message;
			return;
		}
		busy = true;
		const result = await apiRequest({
			method: panel.kind === 'edit' ? 'PATCH' : 'POST',
			url: panel.kind === 'edit' ? `/api/access-rules/${panel.id}` : '/api/access-rules',
			body: checked.data,
			reply: changedReplySchema
		});
		busy = false;
		if (!result.ok) {
			problem = result.message;
			return;
		}
		showToast(panel.kind === 'edit' ? 'Saved.' : 'Rule added.', 'success');
		panel = { kind: 'view', id: result.data.id };
		await refreshAll();
	}

	async function remove(rule: AccessRuleView): Promise<void> {
		const yes = await confirmAction({
			title: `Delete the rule ${describe(rule)}?`,
			message:
				'People in the group lose what this rule gave them on those machines at once, unless another rule gives it too.',
			confirmLabel: 'Delete rule'
		});
		if (!yes) {
			return;
		}
		const result = await apiRequest({
			method: 'DELETE',
			url: `/api/access-rules/${rule.id}`,
			body: undefined,
			reply: changedReplySchema
		});
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		showToast('Rule deleted.', 'success');
		close();
		await refreshAll();
	}
</script>

<PageHeader
	title="Access rules"
	summary="Each rule lets one group of people do certain things on one group of machines. Rules add up; nothing is denied."
>
	{#snippet actions()}
		<ExportButton href={resolve('/api/exports/access-rules')} />
		<Button
			variant="primary"
			size="compact"
			type="button"
			onclick={() => {
				openForm(undefined);
			}}
		>
			<IconPlus size={18} /> New rule
		</Button>
	{/snippet}
</PageHeader>

{#snippet ruleRow(rule: AccessRuleView)}
	<ListRow
		action={{ kind: 'button', onclick: () => (panel = { kind: 'view', id: rule.id }) }}
		align="start"
		dimmed={false}
	>
		<span class="rule">
			<span class="pair">
				<span class="name">{groupName(data.userGroups, rule.userGroupId)}</span>
				<IconArrowRight size={16} />
				<span class="name">{groupName(data.machineGroups, rule.machineGroupId)}</span>
			</span>
			<PermissionChips permissions={rule.permissions} />
			<span class="consent">{consentLabel(rule.consent)}</span>
		</span>
	</ListRow>
{/snippet}

<ListCard
	heading={undefined}
	actions={undefined}
	label="Access rules"
	items={data.rules}
	key={(rule: AccessRuleView) => rule.id}
	row={ruleRow}
	empty="No rules yet, so members see no machines. Add a rule to give a group of people access to a group of machines."
/>

<ActiveShareLinks links={data.activeShareLinks} loadedAtMs={data.now} />

<Modal
	open={panel.kind === 'view' && selected !== undefined}
	title={selected === undefined ? '' : describe(selected)}
	onclose={close}
>
	{#if selected !== undefined}
		<dl class="facts">
			<dt>People in</dt>
			<dd>{groupName(data.userGroups, selected.userGroupId)}</dd>
			<dt>Machines in</dt>
			<dd>{groupName(data.machineGroups, selected.machineGroupId)}</dd>
			<dt>May</dt>
			<dd><PermissionChips permissions={selected.permissions} /></dd>
			<dt>Consent</dt>
			<dd>{consentLabel(selected.consent)}</dd>
		</dl>
	{/if}
	{#snippet footer()}
		{#if selected !== undefined}
			{@const rule = selected}
			<Button variant="danger" size="compact" type="button" onclick={() => void remove(rule)}>
				Delete
			</Button>
			<Button
				variant="primary"
				size="compact"
				type="button"
				onclick={() => {
					openForm(rule);
				}}
			>
				Edit
			</Button>
		{/if}
	{/snippet}
</Modal>

<Modal
	open={panel.kind === 'add' || (panel.kind === 'edit' && selected !== undefined)}
	title={panel.kind === 'add' ? 'New access rule' : 'Edit access rule'}
	onclose={close}
>
	<RuleForm
		userGroups={data.userGroups}
		machineGroups={data.machineGroups}
		bind:userGroupId
		bind:machineGroupId
		bind:permissions
		bind:consent
		error={problem}
	/>
	{#snippet footer()}
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={() => {
				if (panel.kind === 'edit') {
					panel = { kind: 'view', id: panel.id };
				} else {
					close();
				}
			}}
		>
			Cancel
		</Button>
		<Button variant="primary" size="compact" type="button" onclick={() => void save()}>
			{busy ? 'Saving…' : panel.kind === 'add' ? 'Add rule' : 'Save'}
		</Button>
	{/snippet}
</Modal>

<style>
	.rule {
		display: grid;
		flex: 1;
		gap: var(--space-2);
		min-width: 0;
	}

	.pair {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		color: var(--muted);
	}

	.name {
		color: var(--text);
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.consent {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.facts {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: var(--space-2) var(--space-4);
		margin: 0;
		font-size: var(--text-sm);
	}

	dt {
		color: var(--muted);
	}

	dd {
		margin: 0;
		overflow-wrap: anywhere;
	}
</style>
