<script lang="ts">
	import { refreshAll } from '$app/navigation';
	import type { ServerUpdateView } from '#lib/schemas/releases/server-updates.ts';
	import { serverUpdateViewSchema } from '#lib/schemas/releases/server-updates.ts';
	import Panel from '#lib/ui/panel.svelte';
	import Button from '#lib/ui/button.svelte';
	import Notice from '#lib/ui/notice.svelte';
	import { confirmAction } from '#lib/ui/confirm-action.svelte.ts';
	import { showToast } from '#lib/ui/toast.svelte.ts';
	import { apiRequest } from '#lib/utils/api-client.ts';
	let { view }: { view: ServerUpdateView } = $props();
	let busy = $state(false);
	async function check(): Promise<void> {
		if (busy) return;
		busy = true;
		try {
			const result = await apiRequest({
				method: 'POST',
				url: '/api/server-updates/check',
				body: {},
				reply: serverUpdateViewSchema
			});
			if (!result.ok) {
				showToast(result.message, 'error');
				return;
			}
			showToast(
				result.data.problem ??
					(result.data.release === null
						? 'The server is up to date.'
						: `BMuster ${result.data.release.version} is available.`),
				result.data.problem === null ? 'success' : 'error'
			);
			await refreshAll();
		} finally {
			busy = false;
		}
	}
	async function install(): Promise<void> {
		if (busy || !view.install.allowed || view.release === null) return;
		const version = view.release.version;
		if (
			!(await confirmAction({
				title: `Update BMuster to ${version}?`,
				message: `${view.release.notes}\n\nThe console will restart and active sessions will end. It may be unavailable for about 30 seconds. Machines receive the signed agent through their configured rollout, pins and update policy. A compatible startup failure restores the previous application; the database is retained.`,
				confirmLabel: 'Update now'
			}))
		)
			return;
		busy = true;
		try {
			const result = await apiRequest({
				method: 'POST',
				url: '/api/server-updates/install',
				body: { version },
				reply: serverUpdateViewSchema
			});
			if (!result.ok) showToast(result.message, 'error');
			else {
				showToast(
					'The launcher will check and install the update. This page shows its progress.',
					'success'
				);
				await refreshAll();
			}
		} finally {
			busy = false;
		}
	}
</script>

<Panel heading="Server" actions={undefined} tone="normal" padding="normal">
	<p>Installed version: <strong>{view.installedVersion}</strong></p>
	<p>Latest signed release: {view.release?.version ?? 'No newer release found'}</p>
	<p>
		Last checked: {view.checkedAtIso === null
			? 'Never'
			: new Date(view.checkedAtIso).toLocaleString()}
	</p>
	{#if view.lastSuccessAtIso !== null && view.problem !== null}<p>
			Last successful check: {new Date(view.lastSuccessAtIso).toLocaleString()}
		</p>{/if}
	{#if view.problem !== null}<Notice tone="danger" title="Update check failed"
			><p>{view.problem}</p></Notice
		>{/if}
	{#if view.operation.phase !== 'idle'}<Notice
			tone={view.operation.phase === 'failed' || view.operation.phase === 'rolled-back'
				? 'warning'
				: 'info'}
			title="Server update: {view.operation.phase}"><p>{view.operation.message}</p></Notice
		>{/if}
	<div class="actions">
		{#if !busy}<Button type="button" variant="secondary" size="compact" onclick={() => void check()}
				>Check for updates</Button
			>{:else}<p>Working…</p>{/if}
		{#if view.install.allowed && !busy}<Button
				type="button"
				variant="primary"
				size="compact"
				onclick={() => void install()}>Update now</Button
			>{/if}
	</div>
	{#if !view.install.allowed}<p class="muted">{view.install.reason}</p>{/if}
	{#if view.deployment === 'docker' && view.release !== null}<p>
			Deploy <code>ghcr.io/jackbrumley/bmuster:v{view.release.version}</code> in Docker or Coolify, then
			recreate the container with its existing data volume.
		</p>{/if}
	{#if view.release !== null}<h3>What’s new in {view.release.version}</h3>
		<p class="notes">{view.release.notes}</p>{/if}
</Panel>

<style>
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
	}
	.muted {
		color: var(--text-muted);
	}
	.notes {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
</style>
