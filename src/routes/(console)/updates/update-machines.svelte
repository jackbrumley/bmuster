<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { IconCloudDownload } from '@tabler/icons-svelte-runes';
	import {
		channelLabel,
		updateStateText,
		type MachineUpdateState,
		type UpdateChannel
	} from '#lib/domain/machines/agent-updates.ts';
	import type { MachineStatus, OsFamily } from '#lib/domain/machines/machine.ts';
	import {
		updateNowReplySchema,
		type UpdateNowRequest
	} from '#lib/schemas/machines/agent-updates.ts';
	import Button from '#lib/ui/button.svelte';
	import ListCard from '#lib/ui/list-card.svelte';
	import ListRow from '#lib/ui/list-row.svelte';
	import OsIcon from '#lib/ui/os-icon.svelte';
	import UpdateBadge from '#lib/ui/update-badge.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	import { formatRelative } from '#lib/utils/format.ts';

	type UpdateMachine = {
		id: string;
		name: string;
		osFamily: OsFamily;
		agentVersion: string;
		status: MachineStatus;
		update: MachineUpdateState;
		channel: UpdateChannel;
	};

	/**
	 * Every machine's agent version and update state, those needing attention first, with Update
	 * now for a selection or for every machine that can take the update.
	 */
	let { machines, now }: { machines: readonly UpdateMachine[]; now: number } = $props();

	/** Failures, then machines behind, then pinned, then up to date. */
	function rank(state: MachineUpdateState): number {
		switch (state.kind) {
			case 'rolled-back':
			case 'refused':
				return 0;
			case 'available':
				return 1;
			case 'updating':
				return 2;
			case 'pinned':
				return 3;
			case 'up-to-date':
			case 'no-release':
				return 4;
		}
	}

	function presenceText(status: MachineStatus): string {
		switch (status.kind) {
			case 'online':
				return 'online';
			case 'reconnecting':
				return 'reconnecting';
			case 'offline':
				return `went offline ${formatRelative(status.sinceIso, now)}`;
		}
	}

	function canUpdate(state: MachineUpdateState): boolean {
		return (
			(state.kind === 'available' && !state.needsReinstall) ||
			state.kind === 'rolled-back' ||
			state.kind === 'refused'
		);
	}

	const sorted = $derived(
		[...machines].sort((a, b) => rank(a.update) - rank(b.update) || a.name.localeCompare(b.name))
	);
	const behind = $derived(machines.filter((machine) => canUpdate(machine.update)));
	const counts = $derived({
		upToDate: machines.filter((machine) => machine.update.kind === 'up-to-date').length,
		behind: machines.filter((machine) => machine.update.kind === 'available').length,
		failed: machines.filter(
			(machine) => machine.update.kind === 'rolled-back' || machine.update.kind === 'refused'
		).length,
		pinned: machines.filter((machine) => machine.update.kind === 'pinned').length
	});

	let selected = $state<Record<string, boolean>>({});
	const selectedIds = $derived(
		behind.filter((machine) => selected[machine.id] === true).map((machine) => machine.id)
	);

	async function updateNow(
		machinesToUpdate: UpdateNowRequest['machines'],
		count: number
	): Promise<void> {
		const yes = await confirmAction({
			title: count === 1 ? 'Update 1 machine now?' : `Update ${String(count)} machines now?`,
			message:
				'Each agent downloads the new version, checks its signature, and switches to it. One that does not check in within 2 minutes goes back to its old version by itself. This skips the staged roll-out.',
			confirmLabel: 'Update now'
		});
		if (!yes) {
			return;
		}
		const result = await apiRequest({
			method: 'POST',
			url: '/api/agent-updates/update-now',
			body: { machines: machinesToUpdate },
			reply: updateNowReplySchema
		});
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		const skipped = result.data.skipped.length;
		showToast(
			`${String(result.data.requested)} ${result.data.requested === 1 ? 'machine updates' : 'machines update'} now${skipped > 0 ? `; ${String(skipped)} skipped (pinned, up to date, or needing a reinstall)` : ''}.`,
			'success'
		);
		selected = {};
		await refreshAll();
	}
</script>

{#snippet actions()}
	{#if selectedIds.length > 0}
		<Button
			variant="primary"
			size="compact"
			type="button"
			onclick={() => {
				void updateNow({ kind: 'some', ids: selectedIds }, selectedIds.length);
			}}><IconCloudDownload size={18} /> Update {selectedIds.length} selected</Button
		>
	{:else if behind.length > 0}
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={() => {
				void updateNow({ kind: 'all' }, behind.length);
			}}><IconCloudDownload size={18} /> Update all now</Button
		>
	{/if}
{/snippet}

{#snippet machineRow(machine: UpdateMachine)}
	<ListRow action={{ kind: 'static' }} align="start" dimmed={false}>
		<span class="pick">
			{#if canUpdate(machine.update)}
				<input
					type="checkbox"
					data-raw-input="row-select"
					aria-label="Select {machine.name}"
					checked={selected[machine.id] === true}
					onchange={(event) => {
						selected[machine.id] = event.currentTarget.checked;
					}}
				/>
			{/if}
		</span>
		<OsIcon family={machine.osFamily} size={20} />
		<div class="body">
			<p class="line">
				<a class="name" href={resolve('/(console)/machines/[id]/manage', { id: machine.id })}
					>{machine.name}</a
				>
				<UpdateBadge state={machine.update} />
			</p>
			<p class="muted">
				Version {machine.agentVersion} · {channelLabel(machine.channel)} · {presenceText(
					machine.status
				)}
			</p>
			{#if machine.update.kind !== 'up-to-date'}
				<p class="detail">{updateStateText(machine.update)}</p>
			{/if}
		</div>
	</ListRow>
{/snippet}

<p class="summary" aria-live="polite">
	{counts.upToDate} up to date · {counts.behind} behind · {counts.failed} failed · {counts.pinned} pinned
</p>

<ListCard
	heading="Machines"
	{actions}
	label="Machines and their agent versions, those needing attention first"
	items={sorted}
	key={(machine: UpdateMachine) => machine.id}
	row={machineRow}
	empty="No machines yet."
/>

<style>
	.summary {
		color: var(--text-soft);
		font-size: var(--text-sm);
	}

	/* A 40px touch target around the box. */
	.pick {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 40px;
		height: 40px;
		flex-shrink: 0;
	}

	.pick input {
		width: 20px;
		height: 20px;
		margin: 0;
		accent-color: var(--brand);
		cursor: pointer;
	}

	.body {
		display: grid;
		flex: 1;
		gap: var(--space-1);
		min-width: 0;
	}

	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.name {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.muted {
		color: var(--muted);
		font-size: var(--text-xs);
	}

	.detail {
		color: var(--text-soft);
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
</style>
