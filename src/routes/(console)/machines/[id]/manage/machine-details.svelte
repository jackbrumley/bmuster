<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { IconEdit } from '@tabler/icons-svelte-runes';
	import type { Machine } from '#lib/domain/machines/machine.ts';
	import {
		machineDetailsReplySchema,
		machineDescriptionSchema,
		machineNameSchema
	} from '#lib/schemas/machines/machine-details.ts';
	import Button from '#lib/ui/button.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import TextField from '#lib/ui/text-field.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * The machine's name and description (SPEC-MACHINE-DETAILS D1, D2), with an
	 * Edit details modal. Admins only: the Manage tab is theirs.
	 */
	let { machine }: { machine: Machine } = $props();

	let open = $state(false);
	let name = $state('');
	let description = $state('');
	let nameError = $state<string | undefined>(undefined);
	let descriptionError = $state<string | undefined>(undefined);

	function openEdit(): void {
		name = machine.name;
		description = machine.description;
		nameError = undefined;
		descriptionError = undefined;
		open = true;
	}

	async function save(): Promise<void> {
		const checkedName = machineNameSchema.safeParse(name);
		const checkedDescription = machineDescriptionSchema.safeParse(description);
		nameError = checkedName.success ? undefined : checkedName.error.issues[0]?.message;
		descriptionError = checkedDescription.success
			? undefined
			: checkedDescription.error.issues[0]?.message;
		if (!checkedName.success || !checkedDescription.success) {
			return;
		}
		const result = await apiRequest({
			method: 'PATCH',
			url: `/api/machines/${machine.id}`,
			body: { name: checkedName.data, description: checkedDescription.data },
			reply: machineDetailsReplySchema
		});
		if (!result.ok) {
			nameError = result.message;
			return;
		}
		open = false;
		showToast('Saved.', 'success');
		await refreshAll();
	}
</script>

<section class="panel" aria-labelledby="details-heading">
	<div class="head">
		<h2 id="details-heading">Details</h2>
		<Button variant="secondary" size="compact" type="button" onclick={openEdit}>
			<IconEdit size={18} /> Edit details
		</Button>
	</div>
	<dl>
		<div>
			<dt>Name</dt>
			<dd>{machine.name}</dd>
		</div>
		<div>
			<dt>Description</dt>
			<dd class="description">{machine.description === '' ? 'None' : machine.description}</dd>
		</div>
	</dl>
</section>

<Modal {open} title="Edit details" onclose={() => (open = false)}>
	<div class="fields">
		<TextField
			label="Name"
			name="name"
			type="text"
			autocomplete="off"
			autocapitalize="off"
			required={true}
			error={nameError}
			bind:value={name}
		/>
		<TextField
			label="Description (what it is for, where it is)"
			name="description"
			type="multiline"
			autocomplete="off"
			autocapitalize="sentences"
			required={false}
			error={descriptionError}
			bind:value={description}
		/>
	</div>
	{#snippet footer()}
		<Button variant="secondary" size="compact" type="button" onclick={() => (open = false)}
			>Cancel</Button
		>
		<Button
			variant="primary"
			size="compact"
			type="button"
			onclick={() => {
				void save();
			}}>Save</Button
		>
	{/snippet}
</Modal>

<style>
	.panel {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-elevated);
		box-shadow: var(--shadow-card);
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	h2 {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--muted);
		text-transform: uppercase;
		letter-spacing: var(--tracking-caps);
	}

	dl {
		display: grid;
		gap: var(--space-3);
		margin: 0;
	}

	dt {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	dd {
		margin: 0;
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		overflow-wrap: anywhere;
	}

	.description {
		white-space: pre-line;
	}

	.fields {
		display: grid;
		gap: var(--space-4);
	}
</style>
