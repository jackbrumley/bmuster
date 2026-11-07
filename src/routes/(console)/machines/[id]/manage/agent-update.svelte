<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import { IconCloudDownload, IconPin, IconPinnedOff } from '@tabler/icons-svelte-runes';
	import { updateStateText, type MachineUpdateState } from '#lib/domain/machines/agent-updates.ts';
	import {
		agentPinReplySchema,
		updateNowReplySchema
	} from '#lib/schemas/machines/agent-updates.ts';
	import Button from '#lib/ui/button.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import UpdateBadge from '#lib/ui/update-badge.svelte';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';

	/**
	 * The Agent panel's update part (SPEC-AGENT-UPDATES): the version, its update state, Update
	 * now and Pin. An agent from before the launcher cannot update itself; that is said plainly,
	 * with the fix (Reinstall agent, further down this page).
	 */
	let {
		machineId,
		version,
		update
	}: { machineId: string; version: string; update: MachineUpdateState } = $props();

	const needsReinstall = $derived(update.kind === 'available' && update.needsReinstall);
	const canUpdate = $derived(
		(update.kind === 'available' && !update.needsReinstall) ||
			update.kind === 'rolled-back' ||
			update.kind === 'refused'
	);

	async function updateNow(): Promise<void> {
		const result = await apiRequest({
			method: 'POST',
			url: '/api/agent-updates/update-now',
			body: { machines: { kind: 'some', ids: [machineId] } },
			reply: updateNowReplySchema
		});
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		const skipped = result.data.skipped[0];
		if (skipped !== undefined) {
			showToast(`Not updated: ${skipped.reason}.`, 'error');
		} else {
			showToast('The agent updates at its next check-in (now, if it is online).', 'success');
		}
		await refreshAll();
	}

	async function setPinned(pinned: boolean): Promise<void> {
		const result = await apiRequest({
			method: 'PATCH',
			url: `/api/machines/${machineId}/agent-pin`,
			body: { pinned },
			reply: agentPinReplySchema
		});
		if (!result.ok) {
			showToast(result.message, 'error');
			return;
		}
		showToast(
			pinned ? 'Pinned: this agent keeps its version.' : 'Unpinned: this agent updates again.',
			'success'
		);
		await refreshAll();
	}
</script>

<div class="state">
	<p class="version">Version {version}</p>
	<UpdateBadge state={update} />
</div>

{#if needsReinstall}
	<Notice tone="warning" title="This agent cannot update itself">
		<p>
			It was installed before automatic updates, so it has no launcher to switch versions. Reinstall
			it once with Reinstall agent below; it keeps this machine's name, notes and history, and
			updates itself from then on.
		</p>
	</Notice>
{:else if update.kind === 'rolled-back' || update.kind === 'refused'}
	<Notice
		tone="danger"
		title={update.kind === 'rolled-back' ? 'Update rolled back' : 'Update refused'}
	>
		<p>{updateStateText(update)}</p>
	</Notice>
{:else}
	<p class="muted">{updateStateText(update)}</p>
{/if}

<div class="buttons">
	{#if canUpdate}
		<Button
			variant="primary"
			size="compact"
			type="button"
			onclick={() => {
				void updateNow();
			}}><IconCloudDownload size={18} /> Update now</Button
		>
	{/if}
	{#if update.kind === 'pinned'}
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={() => {
				void setPinned(false);
			}}><IconPinnedOff size={18} /> Unpin</Button
		>
	{:else if update.kind !== 'no-release'}
		<Button
			variant="secondary"
			size="compact"
			type="button"
			onclick={() => {
				void setPinned(true);
			}}><IconPin size={18} /> Pin to this version</Button
		>
	{/if}
</div>

<style>
	.state {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.version {
		font-weight: var(--weight-semibold);
	}

	.muted {
		color: var(--muted);
		font-size: var(--text-sm);
	}

	.buttons {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
</style>
