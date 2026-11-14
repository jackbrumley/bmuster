<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IconHandStop } from '@tabler/icons-svelte-runes';
	import { mcpSettingsReplySchema, stoppedReplySchema } from '#lib/schemas/mcp/console.ts';
	import AiAssistantHelp from '#lib/ui/ai-assistant-help.svelte';
	import Button from '#lib/ui/button.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import Notice from '#lib/ui/notice.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import ConnectedAssistants from '../../connected-assistants.svelte';
	import ApproverSettings from './approver-settings.svelte';
	import SettingsTabs from '../settings-tabs.svelte';
	import type { PageProps } from './$types';

	/**
	 * Settings → AI assistants (SPEC-MCP 8.5): Allow AI assistants (MCP) and who may connect one,
	 * saved together, and which permission a rule must give (SPEC-MCP M41); who may approve their
	 * commands; every connected assistant with Disconnect; Stop all AI access.
	 */
	let { data }: PageProps = $props();

	const ON_OFF: { value: 'on' | 'off'; label: string }[] = [
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	];

	/** What the admin has changed since the last save; null shows the saved value. */
	let editedOn = $state<'on' | 'off' | null>(null);
	let editedGroup = $state<string | null>(null);
	let busy = $state(false);

	const savedGroup = $derived(
		data.settings.userGroup.kind === 'group' ? data.settings.userGroup.id : null
	);
	const on = $derived(editedOn ?? (data.settings.enabled ? 'on' : 'off'));
	const group = $derived(editedGroup ?? savedGroup);
	const groupOptions = $derived(
		data.groups.map((choice) => ({ value: choice.id, label: choice.name }))
	);
	const changed = $derived((on === 'on') !== data.settings.enabled || group !== savedGroup);

	async function save(): Promise<void> {
		busy = true;
		const result = await apiRequest({
			method: 'PUT',
			url: '/api/mcp/settings',
			body: { enabled: on === 'on', userGroupId: group },
			reply: mcpSettingsReplySchema
		});
		busy = false;
		showToast(
			result.ok ? 'AI assistant settings are saved.' : result.message,
			result.ok ? 'success' : 'error'
		);
		if (result.ok) {
			editedOn = null;
			editedGroup = null;
		}
		await refreshAll();
	}

	async function stopAll(): Promise<void> {
		const yes = await confirmAction({
			title: 'Stop all AI access?',
			message:
				'This turns AI assistants off and disconnects every one of them now. Requests waiting for approval are cancelled. People must connect them again after an admin turns it back on.',
			confirmLabel: 'Stop all AI access'
		});
		if (!yes) {
			return;
		}
		const result = await apiRequest({
			method: 'POST',
			url: '/api/mcp/stop-all',
			body: {},
			reply: stoppedReplySchema
		});
		showToast(
			result.ok
				? `All AI access stopped. ${String(result.data.grantsEnded)} disconnected.`
				: result.message,
			result.ok ? 'success' : 'error'
		);
		await refreshAll();
	}
</script>

<PageHeader
	title="Settings"
	summary="How this server behaves. Every change is in Activity."
	actions={undefined}
/>

<SettingsTabs />

<Panel heading="Allow AI assistants (MCP)" actions={undefined} tone="normal" padding="normal">
	<p class="lead">
		Lets people connect an AI assistant, such as Claude or ChatGPT, to act as them. Off until you
		choose who may.
	</p>
	<p class="lead">
		Then add an access rule on <a href={resolve('/(console)/access')}>Access rules</a> for those people
		and machines, giving AI can view (the assistant sees the machines) or AI commands (it can also ask
		to run commands, each approved by a person). Admins need a rule too.
	</p>
	{#if data.settings.userGroup.kind === 'missing'}
		<Notice tone="warning" title="The group was deleted">
			<p>Nobody can connect an AI assistant until you choose another group.</p>
		</Notice>
	{/if}
	<SegmentedControl
		label="Allow AI assistants (MCP)"
		options={ON_OFF}
		bind:value={() => on, (picked: 'on' | 'off' | null) => (editedOn = picked)}
	/>
	{#if groupOptions.length === 0}
		<p class="lead">Make a group of people on the Groups page first.</p>
	{:else}
		<SegmentedControl
			label="People who may connect an AI assistant"
			options={groupOptions}
			bind:value={() => group, (picked: string | null) => (editedGroup = picked)}
		/>
	{/if}
	<div class="save">
		<Button
			variant="primary"
			size="compact"
			type="button"
			onclick={changed && !busy ? () => void save() : undefined}
		>
			{busy ? 'Saving…' : 'Save'}
		</Button>
	</div>
</Panel>

<ApproverSettings approvers={data.approvers} groups={data.groups} />

<AiAssistantHelp serverUrl={data.serverUrl} state={data.settings.enabled ? 'on' : 'off'} />

<ConnectedAssistants grants={data.grants} now={data.now} showPerson={true} />

<Panel heading="Stop all AI access" actions={undefined} tone="danger" padding="normal">
	<p class="lead">
		Turns AI assistants off and disconnects every assistant, for everyone, at once. Requests waiting
		for approval are cancelled, and runs they started stop before any machine not yet started. Use
		it if you think one is misbehaving.
	</p>
	<div class="save">
		<Button variant="danger" size="compact" type="button" onclick={() => void stopAll()}>
			<IconHandStop size={18} /> Stop all AI access
		</Button>
	</div>
</Panel>

<style>
	.lead {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	a {
		color: var(--brand);
	}

	.save {
		display: flex;
		justify-content: flex-end;
	}
</style>
