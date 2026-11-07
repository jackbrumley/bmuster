<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IconEdit } from '@tabler/icons-svelte-runes';
	import type { MachineGroupView } from '#lib/domain/access/access.ts';
	import { changedReplySchema } from '#lib/schemas/access/access.ts';
	import Button from '#lib/ui/button.svelte';
	import Panel from '#lib/ui/panel.svelte';
	import Checkbox from '#lib/ui/checkbox.svelte';
	import Modal from '#lib/ui/modal.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * The machine's groups (SPEC-ACCESS A2), with a modal to change them. It
	 * is always in All machines, which is not offered.
	 */
	let { machineId, groups }: { machineId: string; groups: MachineGroupView[] } = $props();

	const chosenGroups = $derived(
		groups.flatMap((group) => (group.membership.kind === 'chosen' ? [group] : []))
	);
	const current = $derived(
		chosenGroups.filter(
			(group) =>
				group.membership.kind === 'chosen' && group.membership.machineIds.includes(machineId)
		)
	);

	let open = $state(false);
	let picked = $state<string[]>([]);
	let problem = $state<string | undefined>(undefined);

	function openEdit(): void {
		picked = current.map((group) => group.id);
		problem = undefined;
		open = true;
	}

	function toggle(id: string, on: boolean): void {
		picked = chosenGroups
			.map((group) => group.id)
			.filter((candidate) => (candidate === id ? on : picked.includes(candidate)));
	}

	async function save(): Promise<void> {
		const result = await apiRequest({
			method: 'PATCH',
			url: `/api/machines/${machineId}/groups`,
			body: { machineGroupIds: picked },
			reply: changedReplySchema
		});
		if (!result.ok) {
			problem = result.message;
			return;
		}
		open = false;
		showToast('Saved.', 'success');
		await refreshAll();
	}
</script>

{#snippet actions()}
	<Button variant="secondary" size="compact" type="button" onclick={openEdit}>
		<IconEdit size={18} /> Change groups
	</Button>
{/snippet}

<Panel heading="Groups" {actions} tone="normal" padding="normal">
	<p class="muted">
		{current.length === 0
			? 'Only in All machines.'
			: `In ${current.map((group) => group.name).join(', ')}, and All machines.`}
		Access rules on these groups decide who can use it.
	</p>
</Panel>

<Modal {open} title="Groups" onclose={() => (open = false)}>
	{#if chosenGroups.length === 0}
		<p class="muted">
			No machine groups yet. <a href={resolve('/(console)/groups')}>Make one on the Groups page</a>.
		</p>
	{:else}
		<div class="choices">
			{#each chosenGroups as group (group.id)}
				<Checkbox
					label={group.name}
					error={undefined}
					bind:checked={
						() => picked.includes(group.id),
						(on: boolean) => {
							toggle(group.id, on);
						}
					}
				/>
			{/each}
		</div>
	{/if}
	{#if problem !== undefined}<p class="problem" role="alert">{problem}</p>{/if}
	{#snippet footer()}
		<Button variant="secondary" size="compact" type="button" onclick={() => (open = false)}>
			Cancel
		</Button>
		<Button variant="primary" size="compact" type="button" onclick={() => void save()}>Save</Button>
	{/snippet}
</Modal>

<style>
	.muted {
		color: var(--muted);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	a {
		color: var(--brand);
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
