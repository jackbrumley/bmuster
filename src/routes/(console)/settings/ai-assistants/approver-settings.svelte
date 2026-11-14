<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		APPROVER_MODES,
		approverModeLabel,
		type ApproverMode
	} from '#lib/domain/commands/assistant-runs.ts';
	import type { ApproverSettingsView } from '#lib/domain/mcp/mcp.ts';
	import { approverSettingsReplySchema } from '#lib/schemas/mcp/console.ts';
	import Button from '#lib/ui/button.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * Who may approve an AI assistant's command (SPEC-MCP M19): the person it acts as (the default),
	 * that person or an approvers group, or only the approvers group. Whoever approves also needs
	 * Run commands on every machine and a recent sign-in.
	 */
	let {
		approvers,
		groups
	}: { approvers: ApproverSettingsView; groups: { id: string; name: string }[] } = $props();

	let editedMode = $state<ApproverMode | null>(null);
	let editedGroup = $state<string | null>(null);
	let busy = $state(false);

	const savedGroup = $derived(approvers.group.kind === 'group' ? approvers.group.id : null);
	const mode = $derived(editedMode ?? approvers.mode);
	const group = $derived(editedGroup ?? savedGroup);
	const modeOptions = APPROVER_MODES.map((value) => ({ value, label: approverModeLabel(value) }));
	const groupOptions = $derived(groups.map((choice) => ({ value: choice.id, label: choice.name })));
	const changed = $derived(
		mode !== approvers.mode || (mode !== 'requester' && group !== savedGroup)
	);
	const ready = $derived(mode === 'requester' || group !== null);

	async function save(): Promise<void> {
		busy = true;
		const result = await apiRequest({
			method: 'PUT',
			url: resolve('/api/mcp/approvers'),
			body: mode === 'requester' ? { mode } : { mode, groupId: group },
			reply: approverSettingsReplySchema
		});
		busy = false;
		showToast(
			result.ok ? 'Who may approve is saved.' : result.message,
			result.ok ? 'success' : 'error'
		);
		if (result.ok) {
			editedMode = null;
			editedGroup = null;
		}
		await refreshAll();
	}
</script>

<Panel heading="Who may approve AI commands" actions={undefined} tone="normal" padding="normal">
	<p class="lead">
		Every command an AI assistant asks for waits on the Approvals page until someone approves it.
		Whoever approves also needs Run commands on every machine in the request, and a sign-in in the
		last 10 minutes (or their password).
	</p>
	{#if approvers.group.kind === 'missing'}
		<Notice tone="warning" title="The approvers group was deleted">
			<p>
				Nobody in a group can approve until you choose another one. With "That person or the
				approvers group", the person each assistant acts as still can.
			</p>
		</Notice>
	{/if}
	<SegmentedControl
		label="Who may approve"
		options={modeOptions}
		bind:value={() => mode, (picked: ApproverMode | null) => (editedMode = picked)}
	/>
	{#if mode !== 'requester'}
		{#if groupOptions.length === 0}
			<p class="lead">Make a group of people on the Groups page first.</p>
		{:else}
			<SegmentedControl
				label="Approvers group"
				options={groupOptions}
				bind:value={() => group, (picked: string | null) => (editedGroup = picked)}
			/>
		{/if}
	{/if}
	<div class="save">
		<Button
			variant="primary"
			size="compact"
			type="button"
			onclick={changed && ready && !busy ? () => void save() : undefined}
		>
			{busy ? 'Saving…' : 'Save'}
		</Button>
	</div>
</Panel>

<style>
	.lead {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.save {
		display: flex;
		justify-content: flex-end;
	}
</style>
