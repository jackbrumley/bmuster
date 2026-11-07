<script lang="ts">
	import { resolve } from '$app/paths';
	import { refreshAll } from '$app/navigation';
	import { IconKey, IconPlus, IconShieldCheck } from '@tabler/icons-svelte-runes';
	import Button from '#lib/ui/button.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import ExportButton from '#lib/ui/export-button.svelte';
	import PageHeader from '#lib/ui/page-header.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { formatRelative } from '#lib/utils/format.ts';
	import {
		roleLabel,
		signInSummary,
		type ConsoleRole,
		type UserView
	} from '#lib/domain/users/user.ts';
	import UserForm from './user-form.svelte';
	import Checkbox from '#lib/ui/checkbox.svelte';
	import { addUser, sendInvitation, setUserGroups, updateUser } from './user-requests.ts';
	import InvitationLink from './invitation-link.svelte';
	import SignInChoice from './sign-in-choice.svelte';
	import type { Invitation } from '#lib/domain/users/invitation.ts';
	import type { PageProps } from './$types';

	/** People who can sign in (SPEC-SIGN-IN S12): list → view → edit. */
	let { data }: PageProps = $props();

	type Panel =
		| { kind: 'closed' }
		| { kind: 'view'; id: string }
		| { kind: 'edit'; id: string }
		| { kind: 'add' };

	let panel = $state<Panel>({ kind: 'closed' });
	let busy = $state(false);
	let problem = $state<string | undefined>(undefined);

	let name = $state('');
	let email = $state('');
	let role = $state<ConsoleRole>('member');
	let password = $state('');
	let signIn = $state<'invite' | 'password' | 'provider'>('invite');
	let link = $state<
		{ kind: 'closed' } | { kind: 'open'; name: string; url: string; expiresIso: string }
	>({ kind: 'closed' });
	let groupIds = $state<string[]>([]);

	const selectedId = $derived(
		panel.kind === 'view' || panel.kind === 'edit' ? panel.id : undefined
	);
	const selected = $derived(data.users.find((user) => user.id === selectedId));

	function close(): void {
		panel = { kind: 'closed' };
		problem = undefined;
		password = '';
	}

	function openAdd(): void {
		name = '';
		email = '';
		role = 'member';
		password = '';
		signIn = 'invite';
		problem = undefined;
		panel = { kind: 'add' };
	}

	/** The user groups someone is in, by name. */
	function groupsOf(userId: string): { id: string; name: string }[] {
		return data.userGroups.filter((group) => group.memberIds.includes(userId));
	}

	function toggleGroup(id: string, on: boolean): void {
		groupIds = data.userGroups
			.map((group) => group.id)
			.filter((candidate) => (candidate === id ? on : groupIds.includes(candidate)));
	}

	function openEdit(user: UserView): void {
		groupIds = groupsOf(user.id).map((group) => group.id);
		name = user.name;
		email = user.email;
		role = user.role;
		password = '';
		problem = undefined;
		panel = { kind: 'edit', id: user.id };
	}

	function canSetPassword(user: UserView): boolean {
		return user.role === 'member' || user.id === data.me;
	}

	async function saveAdd(): Promise<void> {
		busy = true;
		const result = await addUser({
			name,
			email,
			role,
			signIn: signIn === 'password' ? { kind: 'password', value: password } : { kind: signIn }
		});
		busy = false;
		if (!result.ok) {
			problem = result.message;
			return;
		}
		close();
		told(result.data.user.name, result.data.invitation);
		await refreshAll();
	}

	/** Says how the person hears about their account (SPEC-EMAIL E5). */
	function told(who: string, invitation: Invitation): void {
		switch (invitation.kind) {
			case 'none':
				showToast(`${who} can now sign in.`, 'success');
				return;
			case 'emailed':
				showToast(`Invitation emailed to ${invitation.to}.`, 'success');
				return;
			case 'link':
				link = { kind: 'open', name: who, url: invitation.url, expiresIso: invitation.expiresIso };
				return;
		}
	}

	async function invite(user: UserView): Promise<void> {
		const result = await sendInvitation(user.id);
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		close();
		told(user.name, result.data);
	}

	/** Never signed in, no password and no provider: an invitation can be (re)sent. */
	function canInvite(user: UserView): boolean {
		return (
			user.status.kind === 'active' &&
			!user.hasPassword &&
			user.providerNames.length === 0 &&
			user.lastSignIn.kind === 'never'
		);
	}

	/** Sends only what changed, one step at a time; stops at the first refusal. */
	async function saveEdit(user: UserView): Promise<void> {
		busy = true;
		const steps: (() => Promise<{ ok: true } | { ok: false; message: string }>)[] = [];
		if (name.trim() !== user.name || email.trim().toLowerCase() !== user.email) {
			steps.push(() => updateUser(user.id, { action: 'set-details', name, email }));
		}
		if (role !== user.role) {
			steps.push(() => updateUser(user.id, { action: 'set-role', role }));
		}
		if (password !== '') {
			steps.push(() => updateUser(user.id, { action: 'set-password', password }));
		}
		const before = groupsOf(user.id).map((group) => group.id);
		if (before.length !== groupIds.length || before.some((id) => !groupIds.includes(id))) {
			steps.push(() => setUserGroups(user.id, groupIds));
		}
		for (const step of steps) {
			const result = await step();
			if (!result.ok) {
				busy = false;
				problem = result.message;
				await refreshAll();
				return;
			}
		}
		busy = false;
		showToast('Saved.', 'success');
		panel = { kind: 'view', id: user.id };
		password = '';
		await refreshAll();
	}

	async function disable(user: UserView): Promise<void> {
		const yes = await confirmAction({
			title: `Disable ${user.name}?`,
			message:
				'They are signed out everywhere at once and cannot sign in until you enable them again.',
			confirmLabel: 'Disable'
		});
		if (!yes) {
			return;
		}
		const result = await updateUser(user.id, { action: 'disable' });
		showToast(
			result.ok ? `${user.name} is disabled.` : result.message,
			result.ok ? 'success' : 'error'
		);
		await refreshAll();
	}

	async function enable(user: UserView): Promise<void> {
		const result = await updateUser(user.id, { action: 'enable' });
		showToast(
			result.ok ? `${user.name} can sign in again.` : result.message,
			result.ok ? 'success' : 'error'
		);
		await refreshAll();
	}
</script>

<PageHeader title="Users" summary="People who can sign in to this console.">
	{#snippet actions()}
		<ExportButton href={resolve('/api/exports/users')} />
		<Button variant="primary" size="compact" type="button" onclick={openAdd}>
			<IconPlus size={18} /> Add user
		</Button>
	{/snippet}
</PageHeader>

{#snippet userRow(user: UserView)}
	<ListRow
		action={{ kind: 'button', onclick: () => (panel = { kind: 'view', id: user.id }) }}
		align="start"
		dimmed={user.status.kind === 'disabled'}
	>
		<span class="avatar">{user.name.slice(0, 1)}</span>
		<span class="body">
			<span class="name">
				{user.name}
				{#if user.role === 'admin'}
					<span class="badge"><IconShieldCheck size={14} /> Admin</span>
				{/if}
				{#if user.status.kind === 'disabled'}
					<span class="badge off">Disabled</span>
				{/if}
			</span>
			<span class="meta">{user.email}</span>
			{#if groupsOf(user.id).length > 0}
				<span class="groups">
					{#each groupsOf(user.id) as group (group.id)}
						<span class="group">{group.name}</span>
					{/each}
				</span>
			{/if}
		</span>
		<span class="side">
			<span class="method">
				{#if user.hasPassword}<IconKey size={14} />{/if}
				{signInSummary(user)}
			</span>
			<span class="meta">
				{user.lastSignIn.kind === 'at' ? formatRelative(user.lastSignIn.iso, data.now) : 'Never'}
			</span>
		</span>
	</ListRow>
{/snippet}

<ListCard
	heading={undefined}
	actions={undefined}
	label="Users"
	items={data.users}
	key={(user: UserView) => user.id}
	row={userRow}
	empty="Nobody yet."
/>

<Modal open={panel.kind === 'add'} title="Add a user" onclose={close}>
	<UserForm
		bind:name
		bind:email
		bind:role
		bind:password
		emailEditable={{ kind: 'yes' }}
		passwordMode={{ kind: 'chosen-separately' }}
	/>
	<SignInChoice bind:choice={signIn} bind:password emailReady={data.emailReady} />
	{#if problem !== undefined}<p class="problem" role="alert">{problem}</p>{/if}
	{#snippet footer()}
		<Button variant="secondary" size="compact" type="button" onclick={close}>Cancel</Button>
		<Button variant="primary" size="compact" type="button" onclick={() => void saveAdd()}>
			{busy ? 'Adding…' : 'Add user'}
		</Button>
	{/snippet}
</Modal>

<InvitationLink {link} onclose={() => (link = { kind: 'closed' })} />

<Modal
	open={panel.kind === 'view' && selected !== undefined}
	title={selected?.name ?? ''}
	onclose={close}
>
	{#if selected !== undefined}
		<dl class="facts">
			<dt>Email</dt>
			<dd>{selected.email}</dd>
			<dt>Role</dt>
			<dd>{roleLabel(selected.role)}</dd>
			<dt>Status</dt>
			<dd>{selected.status.kind === 'active' ? 'Can sign in' : 'Disabled'}</dd>
			<dt>Groups</dt>
			<dd>
				{groupsOf(selected.id).length === 0
					? 'None, so no machines unless they are an admin'
					: groupsOf(selected.id)
							.map((group) => group.name)
							.join(', ')}
			</dd>
			<dt>Signs in with</dt>
			<dd>{signInSummary(selected)}</dd>
			<dt>Last sign-in</dt>
			<dd>
				{selected.lastSignIn.kind === 'at'
					? formatRelative(selected.lastSignIn.iso, data.now)
					: 'Never'}
			</dd>
		</dl>
	{/if}
	{#snippet footer()}
		{#if selected !== undefined}
			{@const user = selected}
			{#if canInvite(user)}
				<Button variant="secondary" size="compact" type="button" onclick={() => void invite(user)}>
					Send invitation
				</Button>
			{/if}
			{#if user.status.kind === 'active'}
				{#if user.id !== data.me}
					<Button
						variant="secondary"
						size="compact"
						type="button"
						onclick={() => void disable(user)}
					>
						Disable
					</Button>
				{/if}
			{:else}
				<Button variant="secondary" size="compact" type="button" onclick={() => void enable(user)}>
					Enable
				</Button>
			{/if}
			<Button
				variant="primary"
				size="compact"
				type="button"
				onclick={() => {
					openEdit(user);
				}}
			>
				Edit
			</Button>
		{/if}
	{/snippet}
</Modal>

<Modal
	open={panel.kind === 'edit' && selected !== undefined}
	title="Edit {selected?.name ?? ''}"
	onclose={close}
>
	{#if selected !== undefined}
		<UserForm
			bind:name
			bind:email
			bind:role
			bind:password
			emailEditable={selected.providerNames.length > 0
				? { kind: 'no', providerNames: selected.providerNames }
				: { kind: 'yes' }}
			passwordMode={canSetPassword(selected)
				? { kind: 'optional-reset' }
				: {
						kind: 'not-here',
						reason: "Only a member's password can be reset. Admins change their own."
					}}
		/>
		<fieldset class="group-picker">
			<legend>Groups</legend>
			{#if data.userGroups.length === 0}
				<p class="hint">No groups yet. Make them on the Groups page.</p>
			{:else}
				{#each data.userGroups as group (group.id)}
					<Checkbox
						label={group.name}
						error={undefined}
						bind:checked={
							() => groupIds.includes(group.id),
							(on: boolean) => {
								toggleGroup(group.id, on);
							}
						}
					/>
				{/each}
			{/if}
		</fieldset>
		{#if problem !== undefined}<p class="problem" role="alert">{problem}</p>{/if}
	{/if}
	{#snippet footer()}
		{#if selected !== undefined}
			{@const user = selected}
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => (panel = { kind: 'view', id: user.id })}
			>
				Cancel
			</Button>
			<Button variant="primary" size="compact" type="button" onclick={() => void saveEdit(user)}>
				{busy ? 'Saving…' : 'Save'}
			</Button>
		{/if}
	{/snippet}
</Modal>

<style>
	.avatar {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		flex-shrink: 0;
		border-radius: var(--radius-round);
		background: var(--brand-tint);
		color: var(--brand);
		font-weight: var(--weight-bold);
	}

	.body {
		display: grid;
		flex: 1;
		min-width: 0;
	}

	.name {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		font-weight: var(--weight-semibold);
	}

	.badge {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0 var(--space-2);
		border-radius: var(--radius-pill);
		background: var(--warning-bg);
		color: var(--warning);
		font-size: var(--text-xs);
	}

	.badge.off {
		background: var(--surface-muted);
		color: var(--muted);
	}

	.meta {
		color: var(--muted);
		font-size: var(--text-xs);
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.side {
		display: grid;
		justify-items: end;
		gap: var(--space-1);
		flex-shrink: 0;
	}

	.method {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-0-5) var(--space-2);
		border-radius: var(--radius-pill);
		background: var(--surface-muted);
		color: var(--text-soft);
		font-size: var(--text-xs);
	}

	.facts {
		display: grid;
		grid-template-columns: auto 1fr;
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

	.groups {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1);
		margin-top: var(--space-1);
	}

	.group {
		padding: 0 var(--space-2);
		border-radius: var(--radius-pill);
		background: var(--brand-tint);
		color: var(--brand);
		font-size: var(--text-xs);
	}

	.group-picker {
		display: grid;
		margin: 0;
		padding: 0;
		border: none;
	}

	legend {
		padding: 0;
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
</style>
