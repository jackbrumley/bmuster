<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { page } from '$app/state';
	import { IconBrandWindows, IconKey, IconPlus, IconShieldLock } from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';
	import CopyField from '#lib/ui/copy-field.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import SegmentedControl from '#lib/ui/segmented-control.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { deletedReplySchema, providerReplySchema } from '#lib/schemas/auth/identity-providers.ts';
	import {
		DEFAULT_SCOPES,
		newPeopleLabel,
		providerPreset,
		type IdentityProviderView,
		type NewPeopleMode,
		type ProviderKind
	} from '#lib/domain/auth/identity-provider.ts';
	import type { PageProps } from './$types';

	/** Sign-in providers (SPEC-SIGN-IN S9). The client secret is write-only. */
	let { data }: PageProps = $props();

	type Panel = { kind: 'closed' } | { kind: 'add' } | { kind: 'edit'; id: string };
	let panel = $state<Panel>({ kind: 'closed' });
	let problem = $state<string | undefined>(undefined);
	let busy = $state(false);

	let kind = $state<ProviderKind>('microsoft-entra');
	let name = $state('');
	let issuer = $state('');
	let clientId = $state('');
	let clientSecret = $state('');
	let scopes = $state('');
	let newPeople = $state<NewPeopleMode>('invited');
	let enabled = $state<'on' | 'off'>('on');

	const preset = $derived(providerPreset(kind));
	const editingId = $derived(panel.kind === 'edit' ? panel.id : undefined);
	const editing = $derived(data.providers.find((provider) => provider.id === editingId));

	const kinds: { value: ProviderKind; label: string }[] = [
		{ value: 'microsoft-entra', label: providerPreset('microsoft-entra').label },
		{ value: 'authentik', label: providerPreset('authentik').label },
		{ value: 'generic-oidc', label: 'Other' }
	];
	const modes: { value: NewPeopleMode; label: string }[] = [
		{ value: 'invited', label: 'Invited only' },
		{ value: 'auto-create', label: 'Anyone it accepts' }
	];
	const onOff: { value: 'on' | 'off'; label: string }[] = [
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	];

	function callbackUrl(id: string): string {
		return `${page.url.origin}/auth/oidc/${id}/callback`;
	}

	function choosePreset(next: ProviderKind): void {
		kind = next;
		if (panel.kind === 'add') {
			name = providerPreset(next).name;
		}
	}

	function openAdd(): void {
		choosePreset('microsoft-entra');
		panel = { kind: 'add' };
		name = providerPreset('microsoft-entra').name;
		issuer = '';
		clientId = '';
		clientSecret = '';
		scopes = DEFAULT_SCOPES.join(' ');
		newPeople = 'invited';
		enabled = 'on';
		problem = undefined;
	}

	function openEdit(provider: IdentityProviderView): void {
		panel = { kind: 'edit', id: provider.id };
		kind = provider.kind;
		name = provider.name;
		issuer = provider.issuer;
		clientId = provider.clientId;
		clientSecret = '';
		scopes = provider.scopes.join(' ');
		newPeople = provider.newPeople;
		enabled = provider.enabled ? 'on' : 'off';
		problem = undefined;
	}

	function close(): void {
		panel = { kind: 'closed' };
		problem = undefined;
	}

	function fields(): Record<string, unknown> {
		return {
			name,
			kind,
			issuer: issuer.trim(),
			clientId,
			scopes: scopes.split(/\s+/).filter((scope) => scope !== ''),
			newPeople,
			enabled: enabled === 'on'
		};
	}

	async function save(): Promise<void> {
		busy = true;
		const result =
			panel.kind === 'edit'
				? await apiRequest({
						method: 'PATCH',
						url: `/api/identity-providers/${panel.id}`,
						body: {
							...fields(),
							clientSecret:
								clientSecret === '' ? { kind: 'keep' } : { kind: 'replace', value: clientSecret }
						},
						reply: providerReplySchema
					})
				: await apiRequest({
						method: 'POST',
						url: '/api/identity-providers',
						body: { ...fields(), clientSecret },
						reply: providerReplySchema
					});
		busy = false;
		if (!result.ok) {
			problem = result.message;
			return;
		}
		showToast(`${result.data.provider.name} is saved.`, 'success');
		clientSecret = '';
		await refreshAll();
		openEdit(result.data.provider);
	}

	async function remove(provider: IdentityProviderView): Promise<void> {
		const yes = await confirmAction({
			title: `Delete ${provider.name}?`,
			message:
				'People can no longer sign in with it. Their accounts stay; anyone without a password needs another way in.',
			confirmLabel: 'Delete'
		});
		if (!yes) {
			return;
		}
		const result = await apiRequest({
			method: 'DELETE',
			url: `/api/identity-providers/${provider.id}`,
			body: undefined,
			reply: deletedReplySchema
		});
		showToast(
			result.ok ? `${provider.name} is deleted.` : result.message,
			result.ok ? 'success' : 'error'
		);
		close();
		await refreshAll();
	}
</script>

<PageHeader
	title="Sign-in"
	summary="How people prove who they are. Access is still set by groups and rules."
	actions={undefined}
/>

{#snippet addProvider()}
	<Button variant="secondary" size="compact" type="button" onclick={openAdd}>
		<IconPlus size={18} /> Add provider
	</Button>
{/snippet}

{#snippet providerRow(provider: IdentityProviderView)}
	<ListRow
		action={{
			kind: 'button',
			onclick: () => {
				openEdit(provider);
			}
		}}
		align="center"
		dimmed={false}
	>
		<span class="icon">
			{#if provider.kind === 'microsoft-entra'}
				<IconBrandWindows size={20} />
			{:else}
				<IconShieldLock size={20} />
			{/if}
		</span>
		<span class="body">
			<span class="name">{provider.name}</span>
			<span class="meta">{newPeopleLabel(provider.newPeople)}</span>
		</span>
		<span class="state" class:on={provider.enabled}>{provider.enabled ? 'On' : 'Off'}</span>
	</ListRow>
{/snippet}

<ListCard
	heading="Identity providers"
	actions={addProvider}
	label="Identity providers"
	items={data.providers}
	key={(provider: IdentityProviderView) => provider.id}
	row={providerRow}
	empty="No providers yet. People sign in with a password."
/>

<Panel heading="Password sign-in" actions={undefined} tone="normal" padding="normal">
	<p class="row-text">
		<IconKey size={18} />
		Admins can always sign in with a password, so a broken provider never locks you out. Other people
		use a password only if an admin gives them one.
	</p>
</Panel>

<Modal
	open={panel.kind !== 'closed'}
	title={panel.kind === 'add' ? 'Add a sign-in provider' : `Edit ${editing?.name ?? ''}`}
	onclose={close}
>
	{#if panel.kind === 'add'}
		<SegmentedControl label="Kind" options={kinds} bind:value={() => kind, choosePreset} />
	{/if}
	{#if editing !== undefined}
		<div class="callback">
			<span class="label">Redirect URI to register with the provider</span>
			<CopyField value={callbackUrl(editing.id)} label="redirect URI" />
		</div>
	{:else}
		<p class="hint">
			After saving, this page shows the redirect URI to register with the provider.
		</p>
	{/if}
	<TextField
		label="Name on the sign-in button"
		name="name"
		type="text"
		autocomplete="off"
		autocapitalize="words"
		required={true}
		error={undefined}
		bind:value={name}
	/>
	<TextField
		label="Issuer URL"
		name="issuer"
		type="url"
		autocomplete="off"
		autocapitalize="off"
		required={true}
		error={undefined}
		bind:value={issuer}
	/>
	<p class="hint">{preset.issuerPlaceholder}<br />{preset.issuerHelp}</p>
	<TextField
		label="Client id"
		name="clientId"
		type="text"
		autocomplete="off"
		autocapitalize="off"
		required={true}
		error={undefined}
		bind:value={clientId}
	/>
	<TextField
		label={editing?.hasClientSecret === true
			? 'Client secret (leave empty to keep the saved one)'
			: 'Client secret'}
		name="clientSecret"
		type="password"
		autocomplete="off"
		autocapitalize="off"
		required={panel.kind === 'add'}
		error={undefined}
		bind:value={clientSecret}
	/>
	<TextField
		label="Scopes"
		name="scopes"
		type="text"
		autocomplete="off"
		autocapitalize="off"
		required={true}
		error={undefined}
		bind:value={scopes}
	/>
	<SegmentedControl label="New people" options={modes} bind:value={newPeople} />
	<p class="hint">{newPeopleLabel(newPeople)}.</p>
	<SegmentedControl label="Sign-in button" options={onOff} bind:value={enabled} />
	{#if problem !== undefined}<p class="problem" role="alert">{problem}</p>{/if}
	{#snippet footer()}
		{#if editing !== undefined}
			{@const provider = editing}
			<span class="spacer">
				<Button
					variant="secondary"
					size="compact"
					type="button"
					onclick={() => void remove(provider)}
				>
					Delete
				</Button>
			</span>
		{/if}
		<Button variant="secondary" size="compact" type="button" onclick={close}>Cancel</Button>
		<Button variant="primary" size="compact" type="button" onclick={() => void save()}>
			{busy ? 'Saving…' : 'Save'}
		</Button>
	{/snippet}
</Modal>

<style>
	.icon {
		display: inline-flex;
		color: var(--text-soft);
	}

	.body {
		display: grid;
		flex: 1;
		min-width: 0;
	}

	.name {
		font-weight: var(--weight-semibold);
	}

	.meta {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.state {
		padding: var(--space-0-5) var(--space-3);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--muted);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
	}

	.state.on {
		background: var(--success-bg);
		color: var(--success);
	}

	.row-text {
		display: flex;
		gap: var(--space-3);
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	.callback {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-1);
	}

	.label {
		color: var(--text-soft);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}

	.hint {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.problem {
		color: var(--danger);
		font-size: var(--text-sm);
	}

	.spacer {
		margin-right: auto;
	}
</style>
