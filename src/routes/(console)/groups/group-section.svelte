<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { IconPlus } from '@tabler/icons-svelte-runes';
	import {
		changedReplySchema,
		groupDescriptionSchema,
		groupNameSchema
	} from '#lib/schemas/access/access.ts';
	import Button from '#lib/ui/button.svelte';
	import Checkbox from '#lib/ui/checkbox.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * One kind of group on the Groups page (SPEC-ACCESS A1–A3, A8): the list,
	 * then a view modal, then the edit and members modals. People and machines
	 * work the same way; the built-in All machines group is read-only.
	 */
	type Group = {
		id: string;
		name: string;
		description: string;
		membership: { kind: 'all-machines' } | { kind: 'chosen'; memberIds: string[] };
	};

	type Candidate = { id: string; label: string; detail: string };

	let {
		kind,
		title,
		nouns,
		groups,
		candidates,
		rulesUsing
	}: {
		kind: 'user' | 'machine';
		title: string;
		/** "person" / "people", "machine" / "machines". */
		nouns: { one: string; many: string };
		groups: Group[];
		candidates: Candidate[];
		/** "IT → Office" for every rule that uses the group. */
		rulesUsing: (groupId: string) => string[];
	} = $props();

	type Panel =
		| { kind: 'closed' }
		| { kind: 'view'; id: string }
		| { kind: 'edit'; id: string }
		| { kind: 'members'; id: string }
		| { kind: 'add' };

	let panel = $state<Panel>({ kind: 'closed' });
	let name = $state('');
	let description = $state('');
	let nameError = $state<string | undefined>(undefined);
	let descriptionError = $state<string | undefined>(undefined);
	let chosen = $state<string[]>([]);
	let problem = $state<string | undefined>(undefined);
	let busy = $state(false);

	const url = $derived(kind === 'user' ? '/api/user-groups' : '/api/machine-groups');
	const selectedId = $derived(
		panel.kind === 'closed' || panel.kind === 'add' ? undefined : panel.id
	);
	const selected = $derived(groups.find((group) => group.id === selectedId));

	function count(group: Group): string {
		if (group.membership.kind === 'all-machines') {
			return 'Every machine';
		}
		const n = group.membership.memberIds.length;
		return `${n} ${n === 1 ? nouns.one : nouns.many}`;
	}

	function memberLabels(group: Group): string[] {
		if (group.membership.kind === 'all-machines') {
			return [];
		}
		const ids = group.membership.memberIds;
		return candidates
			.filter((candidate) => ids.includes(candidate.id))
			.map((candidate) => candidate.label);
	}

	function close(): void {
		panel = { kind: 'closed' };
		problem = undefined;
	}

	function openDetails(group: Group | undefined): void {
		name = group?.name ?? '';
		description = group?.description ?? '';
		nameError = undefined;
		descriptionError = undefined;
		problem = undefined;
		panel = group === undefined ? { kind: 'add' } : { kind: 'edit', id: group.id };
	}

	function openMembers(group: Group): void {
		chosen = group.membership.kind === 'chosen' ? [...group.membership.memberIds] : [];
		problem = undefined;
		panel = { kind: 'members', id: group.id };
	}

	function toggle(id: string, on: boolean): void {
		chosen = candidates
			.map((candidate) => candidate.id)
			.filter((candidate) => (candidate === id ? on : chosen.includes(candidate)));
	}

	async function saveDetails(): Promise<void> {
		const checkedName = groupNameSchema.safeParse(name);
		const checkedDescription = groupDescriptionSchema.safeParse(description);
		nameError = checkedName.success ? undefined : checkedName.error.issues[0]?.message;
		descriptionError = checkedDescription.success
			? undefined
			: checkedDescription.error.issues[0]?.message;
		if (!checkedName.success || !checkedDescription.success) {
			return;
		}
		const details = { name: checkedName.data, description: checkedDescription.data };
		busy = true;
		const result =
			panel.kind === 'edit'
				? await apiRequest({
						method: 'PATCH',
						url: `${url}/${panel.id}`,
						body: { action: 'set-details', ...details },
						reply: changedReplySchema
					})
				: await apiRequest({ method: 'POST', url, body: details, reply: changedReplySchema });
		busy = false;
		if (!result.ok) {
			nameError = result.message;
			return;
		}
		showToast(panel.kind === 'edit' ? 'Saved.' : `${details.name} is ready.`, 'success');
		panel = { kind: 'view', id: result.data.id };
		await refreshAll();
	}

	async function saveMembers(group: Group): Promise<void> {
		busy = true;
		const result = await apiRequest({
			method: 'PATCH',
			url: `${url}/${group.id}`,
			body: { action: 'set-members', memberIds: chosen },
			reply: changedReplySchema
		});
		busy = false;
		if (!result.ok) {
			problem = result.message;
			return;
		}
		showToast('Saved.', 'success');
		panel = { kind: 'view', id: group.id };
		await refreshAll();
	}

	async function remove(group: Group): Promise<void> {
		const rules = rulesUsing(group.id);
		const yes = await confirmAction({
			title: `Delete ${group.name}?`,
			message:
				rules.length === 0
					? `No access rules use it. The ${nouns.many} in it stay; only the group goes.`
					: `These access rules use it and are deleted too: ${rules.join('; ')}. The ${nouns.many} in it stay; only the group and its rules go.`,
			confirmLabel: rules.length === 0 ? 'Delete group' : 'Delete group and rules'
		});
		if (!yes) {
			return;
		}
		const result = await apiRequest({
			method: 'DELETE',
			url: `${url}/${group.id}`,
			body: undefined,
			reply: changedReplySchema
		});
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		showToast(`${group.name} was deleted.`, 'success');
		close();
		await refreshAll();
	}
</script>

<section class="section" aria-labelledby="{kind}-groups-heading">
	<div class="head">
		<h2 id="{kind}-groups-heading">{title}</h2>
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={() => {
				openDetails(undefined);
			}}
		>
			<IconPlus size={18} /> New group
		</Button>
	</div>
	{#if groups.length === 0}
		<p class="empty">No groups of {nouns.many} yet.</p>
	{:else}
		<ul class="list">
			{#each groups as group (group.id)}
				<li>
					<button
						data-raw-button="list-row"
						type="button"
						class="row"
						onclick={() => (panel = { kind: 'view', id: group.id })}
					>
						<span class="body">
							<span class="name">{group.name}</span>
							{#if group.description !== ''}
								<span class="meta">{group.description}</span>
							{/if}
						</span>
						<span class="count">{count(group)}</span>
					</button>
				</li>
			{/each}
		</ul>
	{/if}
</section>

<Modal
	open={panel.kind === 'view' && selected !== undefined}
	title={selected?.name ?? ''}
	onclose={close}
>
	{#if selected !== undefined}
		{@const rules = rulesUsing(selected.id)}
		{#if selected.description !== ''}
			<p class="description">{selected.description}</p>
		{/if}
		<dl class="facts">
			<dt>{nouns.many.slice(0, 1).toUpperCase()}{nouns.many.slice(1)}</dt>
			<dd>
				{#if selected.membership.kind === 'all-machines'}
					Every machine on this server, now and later. Machines cannot be added or taken out.
				{:else if memberLabels(selected).length === 0}
					None yet
				{:else}
					{memberLabels(selected).join(', ')}
				{/if}
			</dd>
			<dt>Access rules</dt>
			<dd>{rules.length === 0 ? 'None' : rules.join('; ')}</dd>
		</dl>
	{/if}
	{#snippet footer()}
		{#if selected?.membership.kind === 'chosen'}
			{@const group = selected}
			<Button variant="danger" size="compact" type="button" onclick={() => void remove(group)}>
				Delete
			</Button>
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => {
					openMembers(group);
				}}
			>
				{kind === 'user' ? 'People' : 'Machines'}
			</Button>
			<Button
				variant="primary"
				size="compact"
				type="button"
				onclick={() => {
					openDetails(group);
				}}
			>
				Edit
			</Button>
		{:else}
			<Button variant="secondary" size="compact" type="button" onclick={close}>Close</Button>
		{/if}
	{/snippet}
</Modal>

<Modal
	open={panel.kind === 'add' || (panel.kind === 'edit' && selected !== undefined)}
	title={panel.kind === 'add' ? `New group of ${nouns.many}` : `Edit ${selected?.name ?? ''}`}
	onclose={close}
>
	<TextField
		label="Name"
		name="name"
		type="text"
		autocomplete="off"
		autocapitalize="words"
		required={true}
		error={nameError}
		bind:value={name}
	/>
	<TextField
		label="Description (optional)"
		name="description"
		type="multiline"
		autocomplete="off"
		autocapitalize="sentences"
		required={false}
		error={descriptionError}
		bind:value={description}
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
		<Button variant="primary" size="compact" type="button" onclick={() => void saveDetails()}>
			{busy ? 'Saving…' : panel.kind === 'add' ? 'Make group' : 'Save'}
		</Button>
	{/snippet}
</Modal>

<Modal
	open={panel.kind === 'members' && selected !== undefined}
	title="{kind === 'user' ? 'People' : 'Machines'} in {selected?.name ?? ''}"
	onclose={close}
>
	{#if candidates.length === 0}
		<p class="empty">No {nouns.many} to choose from yet.</p>
	{:else}
		<div class="choices">
			{#each candidates as candidate (candidate.id)}
				<Checkbox
					label={candidate.detail === ''
						? candidate.label
						: `${candidate.label} (${candidate.detail})`}
					error={undefined}
					bind:checked={
						() => chosen.includes(candidate.id),
						(on: boolean) => {
							toggle(candidate.id, on);
						}
					}
				/>
			{/each}
		</div>
	{/if}
	{#if problem !== undefined}<p class="problem" role="alert">{problem}</p>{/if}
	{#snippet footer()}
		{#if selected !== undefined}
			{@const group = selected}
			<Button
				variant="secondary"
				size="compact"
				type="button"
				onclick={() => (panel = { kind: 'view', id: group.id })}
			>
				Cancel
			</Button>
			<Button
				variant="primary"
				size="compact"
				type="button"
				onclick={() => void saveMembers(group)}
			>
				{busy ? 'Saving…' : 'Save'}
			</Button>
		{/if}
	{/snippet}
</Modal>

<style>
	.section {
		display: grid;
		gap: var(--space-3);
		min-width: 0;
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	h2 {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
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

	li + li {
		border-top: 1px solid var(--border);
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		min-height: 56px;
		padding: var(--space-3) var(--space-4);
		border: none;
		background: transparent;
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}

	.row:hover {
		background: var(--surface-muted);
	}

	.body {
		display: grid;
		flex: 1;
		min-width: 0;
	}

	.name {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.meta {
		color: var(--muted);
		font-size: var(--text-xs);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.count {
		flex-shrink: 0;
		color: var(--brand);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
	}

	.empty {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.description {
		color: var(--text-soft);
		font-size: var(--text-sm);
		white-space: pre-line;
		overflow-wrap: anywhere;
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

	.choices {
		display: grid;
		max-height: 50dvh;
		overflow-y: auto;
	}

	.problem {
		color: var(--danger);
		font-size: var(--text-sm);
	}
</style>
