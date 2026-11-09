<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { IconKey, IconPlus } from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';
	import CopyField from '#lib/ui/copy-field.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { formatRelative } from '#lib/utils/format.ts';
	import {
		tokenStateLabel,
		type DiagnosticsTokenDays,
		type DiagnosticsTokenView
	} from '#lib/domain/logs/diagnostics-tokens.ts';
	import {
		createTokenRequestSchema,
		createdTokenReplySchema,
		revokedTokenReplySchema
	} from '#lib/schemas/logs/logs.ts';
	import SettingsTabs from '../settings-tabs.svelte';
	import type { PageProps } from './$types';

	/**
	 * Read-only diagnostics tokens (SPEC-AGENT-LOGS 4): for a tool or the developer's AI to read
	 * machine logs and reports. A token is shown once, then only its name and dates.
	 */
	let { data }: PageProps = $props();

	type DayChoice = `${DiagnosticsTokenDays}`;
	const DAY_OPTIONS: readonly { value: DayChoice; label: string }[] = [
		{ value: '1', label: '1 day' },
		{ value: '7', label: '7 days' },
		{ value: '30', label: '30 days' },
		{ value: '90', label: '90 days' }
	];

	let panel = $state<{ kind: 'closed' } | { kind: 'create' } | { kind: 'shown'; token: string }>({
		kind: 'closed'
	});
	let name = $state('');
	let days = $state<DayChoice | null>('7');
	let problem = $state<string | undefined>(undefined);
	let busy = $state(false);
	const now = Date.now();

	/** "9 Nov 2026": when a token stops working. */
	function day(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });
	}

	function openCreate(): void {
		name = '';
		days = '7';
		problem = undefined;
		panel = { kind: 'create' };
	}

	function close(): void {
		panel = { kind: 'closed' };
	}

	async function create(): Promise<void> {
		const parsed = createTokenRequestSchema.safeParse({ name, days: Number(days) });
		if (!parsed.success) {
			problem = parsed.error.issues[0]?.message;
			return;
		}
		busy = true;
		const result = await apiRequest({
			method: 'POST',
			url: '/api/diagnostics-tokens',
			body: parsed.data,
			reply: createdTokenReplySchema
		});
		busy = false;
		if (!result.ok) {
			problem = result.message;
			return;
		}
		panel = { kind: 'shown', token: result.data.token };
		await refreshAll();
	}

	async function revoke(token: DiagnosticsTokenView): Promise<void> {
		const yes = await confirmAction({
			title: `Revoke “${token.name}”?`,
			message: 'Anything using it is refused from now on. This cannot be undone.',
			confirmLabel: 'Revoke'
		});
		if (!yes) {
			return;
		}
		const result = await apiRequest({
			method: 'DELETE',
			url: `/api/diagnostics-tokens/${token.id}`,
			body: undefined,
			reply: revokedTokenReplySchema
		});
		showToast(result.ok ? 'Token revoked.' : result.message, result.ok ? 'success' : 'error');
		await refreshAll();
	}
</script>

<PageHeader title="Settings" summary="How this server behaves. Every change is in Activity.">
	{#snippet actions()}
		<Button variant="primary" size="compact" type="button" onclick={openCreate}>
			<IconPlus size={18} /> Create token
		</Button>
	{/snippet}
</PageHeader>

<SettingsTabs />

{#snippet tokenRow(token: DiagnosticsTokenView)}
	<ListRow action={{ kind: 'static' }} align="start" dimmed={token.state !== 'active'}>
		<span class="icon"><IconKey size={20} /></span>
		<span class="body">
			<span class="name">{token.name}</span>
			<span class="meta">
				{tokenStateLabel(token.state)} · made by {token.ownerName}
				{formatRelative(token.createdIso, now)} · {token.state === 'expired'
					? 'expired'
					: 'expires'}
				{day(token.expiresIso)}
			</span>
			<span class="meta">
				{token.lastUsed.kind === 'used'
					? `Last used ${formatRelative(token.lastUsed.atIso, now)}`
					: 'Never used'}
			</span>
		</span>
		{#if token.state === 'active'}
			<Button variant="danger" size="compact" type="button" onclick={() => void revoke(token)}>
				Revoke
			</Button>
		{/if}
	</ListRow>
{/snippet}

<ListCard
	heading="Diagnostics tokens"
	actions={undefined}
	label="Diagnostics tokens, newest first"
	items={data.tokens}
	key={(token: DiagnosticsTokenView) => token.id}
	row={tokenRow}
	empty="No tokens. A token lets a tool read machine logs and reports, and nothing else."
/>

<Modal
	open={panel.kind !== 'closed'}
	title={panel.kind === 'shown' ? 'Copy the token now' : 'Create a diagnostics token'}
	onclose={close}
>
	{#if panel.kind === 'shown'}
		<p class="note">
			This is the only time the token is shown. It reads machine logs, reports and the server log as
			you, until it expires, you revoke it or you stop being an admin.
		</p>
		<CopyField value={panel.token} label="diagnostics token" />
		<p class="note">
			For <code>npm run diagnostics</code>, save it to
			<code>~/.config/bmuster/diagnostics-token</code> with mode 0600.
		</p>
	{:else}
		<TextField
			label="Name"
			name="name"
			type="text"
			autocomplete="off"
			autocapitalize="sentences"
			required={true}
			error={problem}
			bind:value={name}
		/>
		<SegmentedControl label="Expires after" options={DAY_OPTIONS} bind:value={days} />
	{/if}
	{#snippet footer()}
		{#if panel.kind === 'shown'}
			<Button variant="primary" size="compact" type="button" onclick={close}>Done</Button>
		{:else}
			<Button variant="secondary" size="compact" type="button" onclick={close}>Cancel</Button>
			<Button variant="primary" size="compact" type="button" onclick={() => void create()}>
				{busy ? 'Creating…' : 'Create'}
			</Button>
		{/if}
	{/snippet}
</Modal>

<style>
	.note {
		font-size: var(--text-sm);
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

	.name {
		font-weight: var(--weight-semibold);
	}

	.meta {
		color: var(--muted);
		font-size: var(--text-xs);
		overflow-wrap: anywhere;
	}
</style>
